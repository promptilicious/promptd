import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Cron } from 'croner';
import { emit } from './events.js';
import { resolveUserPath } from './paths.js';
import { getCron, listCrons, logDir, logFileName, patchCron, pruneLogs } from './store.js';
import { hasUsageDelay, normalizeUsageDelay, usageBlockers, usageMonitor } from './usage.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// How often a trigger held for usage re-checks whether its limits have cleared.
// Short, because the run is supposed to go the moment they do; the reading it
// checks against is the cached one unless the reset time has passed.
const DELAY_REVIEW_MS = 30 * 1000;

/**
 * Streaming JSON gives us the assistant text as it is produced plus a final
 * result event carrying the CLI's own usage accounting, which is the only
 * trustworthy source for tokens and cost.
 */
const CLAUDE_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

/**
 * Prepended to every prompt the CLI is given. A cron run has no session to come
 * back to: the process is gone the moment the turn ends, so work deferred to a
 * wakeup, a background command, or a loop is simply lost. The run's own prompt
 * is what the user wrote, so this stays out of the log — the header still shows
 * the prompt as it was typed.
 */
const PROMPT_PREFIX =
  'Headless run: nothing resumes you. The moment you end a turn without a tool call, this process exits. ' +
  'A scheduled wakeup, a backgrounded command, or a task notification never arrives. Do all waiting inside ' +
  'the turn with a blocking command. Never use ScheduleWakeup, run_in_background, or /loop to carry ' +
  'remaining work forward.';

/** The prompt as the CLI receives it: the preamble, then what the cron says. */
function promptFor(cron) {
  const prompt = cron.prompt ?? '';
  return prompt.trim() ? `${PROMPT_PREFIX}\n\n${prompt}` : PROMPT_PREFIX;
}

/**
 * The durations the Pause for control offers. `ms: null` means "no timer" — the
 * pause is only lifted by cancelling it or by the process restarting, since the
 * pause is never written to disk.
 */
export const PAUSE_OPTIONS = [
  { id: '15m', label: '15 minutes', ms: 15 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '6h', label: '6 hours', ms: 6 * 60 * 60 * 1000 },
  { id: 'restart', label: 'until restart', ms: null },
];

/**
 * The effort levels the CLI accepts for `--effort`. An empty effort on a cron
 * means the flag is left off, so the CLI uses whatever it is configured to use.
 */
export const EFFORT_LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

export function isEffortLevel(value) {
  return EFFORT_LEVELS.some((level) => level.id === value);
}

export function pauseOption(id) {
  return PAUSE_OPTIONS.find((option) => option.id === id) ?? null;
}

function formatRuntime(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.round((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/** Builds the run's statistics block from the CLI's result event. */
function statsBlock(result) {
  const usage = result?.usage ?? {};
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cache = (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const total = input + output + cache;
  const models = Object.keys(result?.modelUsage ?? {});
  const cost = typeof result?.total_cost_usd === 'number' ? `$${result.total_cost_usd.toFixed(4)}` : 'unknown';
  const count = (n) => n.toLocaleString('en-US');

  return [
    '',
    '=-----------------------------------=',
    `Model: ${models.length ? models.join(', ') : 'unknown'}`,
    `Runtime: ${formatRuntime(result?.duration_ms)}`,
    `Tokens: ${count(total)} (in ${count(input)} / out ${count(output)} / cache ${count(cache)})`,
    `Cost: ${cost}`,
    '=-----------------------------------=',
    '',
  ].join('\n');
}

export function validateCronExpression(expression) {
  try {
    const probe = new Cron(String(expression).trim(), { paused: true });
    if (!probe.nextRun()) return { ok: false, error: 'expression has no future run times' };
    probe.stop();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Next fire time for an expression, without scheduling anything. */
export function previewNextRun(expression) {
  try {
    const probe = new Cron(String(expression).trim(), { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/**
 * When a held trigger can go: every blocking limit has to clear, so it is the
 * latest of their reset times. A blocker that reports no reset — extra credits
 * on an account with no monthly boundary to read — returns null, and the review
 * poll decides instead of a timer.
 */
function resumeTime(blockers) {
  if (!blockers.length) return null;
  if (blockers.some((blocker) => !blocker.resetsAt)) return null;
  return blockers.map((blocker) => blocker.resetsAt).sort().at(-1);
}

/** "Session, Weekly" — the limits a trigger is waiting on, for a log or a badge. */
function blockerNames(blockers) {
  return blockers.map((blocker) => blocker.label).join(', ');
}

class CronService {
  constructor() {
    /** @type {Map<string, Cron>} cron id -> scheduled job */
    this.jobs = new Map();
    /** @type {Map<string, object>} cron id -> in-flight run, JSON-safe for the API */
    this.running = new Map();
    /** @type {Map<string, object>} cron id -> child process and log stream, kept out of responses */
    this.handles = new Map();
    /**
     * Set while every schedule is held. Deliberately memory-only: a restart is
     * one of the two documented ways out of a pause, so it must not survive one.
     * @type {{mode: 'manual'|'update', label: string, option: string|null, startedAt: string, until: string|null}|null}
     */
    this.pauseState = null;
    this.pauseTimer = null;
    /**
     * Triggers held because a usage limit the cron watches is spent. At most one
     * per cron: a second trigger arriving while one waits is lost, not queued.
     * Memory-only like the pause, so a restart comes back with nothing waiting
     * and the next trigger checks usage fresh.
     * @type {Map<string, object>} cron id -> waiting trigger
     */
    this.delayed = new Map();
    this.delayTimer = null;
    this.reviewing = false;
  }

  isPaused() {
    return this.pauseState !== null;
  }

  /** An update pause is the one kind the user cannot cancel. */
  isPausedForUpdate() {
    return this.pauseState?.mode === 'update';
  }

  /** How many runs are still in flight; what an update waits to reach zero. */
  runningCount() {
    return this.running.size;
  }

  /** JSON-safe pause state for the API and the status badges. */
  pauseInfo() {
    if (!this.pauseState) {
      return { paused: false, mode: null, label: null, badge: null, until: null, startedAt: null, remainingMs: null, cancellable: false, runningCount: this.running.size };
    }
    const { mode, label, option, startedAt, until } = this.pauseState;
    return {
      paused: true,
      mode,
      option,
      label,
      // What every status badge shows, so the wording lives in one place.
      badge: `Paused ${label}`,
      startedAt,
      until,
      remainingMs: until ? Math.max(0, new Date(until).getTime() - Date.now()) : null,
      cancellable: mode === 'manual',
      runningCount: this.running.size,
    };
  }

  /**
   * Holds every schedule. Runs already in flight are left alone — they keep
   * their running badge and finish on their own.
   */
  async pauseAll({ mode = 'manual', label, option = null, ms = null }) {
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;

    const startedAt = new Date();
    this.pauseState = {
      mode,
      label,
      option,
      startedAt: startedAt.toISOString(),
      until: ms ? new Date(startedAt.getTime() + ms).toISOString() : null,
    };

    await this.reload(); // stops every job; reload leaves them stopped while paused
    if (ms) {
      this.pauseTimer = setTimeout(() => {
        this.resumeAll('timer expired').catch((err) => console.error(`[cron] resume failed: ${err.message}`));
      }, ms);
      this.pauseTimer.unref?.();
    }
    console.log(`[cron] paused ${label} (${mode}); ${this.running.size} run(s) still in flight`);
    emit('pause:changed', this.pauseInfo());
    return this.pauseInfo();
  }

  /** Lifts a pause and re-arms whatever is still active on disk. */
  async resumeAll(reason = 'cancelled') {
    if (!this.pauseState) return this.pauseInfo();
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.pauseTimer = null;
    const previous = this.pauseState;
    this.pauseState = null;
    await this.reload();
    console.log(`[cron] resumed after "${previous.label}" pause (${reason})`);
    emit('pause:changed', { ...this.pauseInfo(), resumedFrom: previous.label, reason });
    // A trigger whose usage cleared during the pause was held by the pause, not
    // by usage. Do not make it wait out another review interval.
    this.reviewDelays().catch((err) => console.error(`[cron] usage delay review failed: ${err.message}`));
    return this.pauseInfo();
  }

  // ---- usage delays ---------------------------------------------------

  /** The trigger waiting on usage for this cron, or null. JSON-safe. */
  delayInfo(cronId) {
    return this.delayed.get(cronId) ?? null;
  }

  isDelayed(cronId) {
    return this.delayed.has(cronId);
  }

  /** How many triggers are waiting on usage. Never counted as running. */
  delayedCount() {
    return this.delayed.size;
  }

  /**
   * Which of this cron's watched limits are over their threshold right now.
   * `fresh` asks the endpoint rather than answering from the last reading, which
   * is what a trigger wants: it is deciding whether to run at all.
   */
  async blockersFor(cron, { fresh = false } = {}) {
    const delay = normalizeUsageDelay(cron.usageDelay);
    if (!hasUsageDelay(delay)) return [];
    const reading = fresh ? await usageMonitor.now() : await usageMonitor.state();
    return usageBlockers(reading, delay);
  }

  /** Parks a trigger until the limits it named clear. */
  hold(cron, source, blockers) {
    const now = new Date().toISOString();
    const entry = {
      cronId: cron.id,
      cronName: cron.name,
      source,
      delayedAt: now,
      checkedAt: now,
      reasons: blockers,
      resumeAt: resumeTime(blockers),
    };
    this.delayed.set(cron.id, entry);
    this.startDelayReview();
    console.log(`[cron] "${cron.name}" ${source} trigger held for usage: ${blockerNames(blockers)}`);
    emit('run:delayed', entry);
    return entry;
  }

  /**
   * Drops a waiting trigger without running it. This is what Stop does to a
   * delayed cron: the schedule is untouched, so the next trigger checks usage
   * again like any other.
   */
  cancelDelay(cronId, cancelledBy = 'user') {
    const entry = this.delayed.get(cronId);
    if (!entry) return null;
    this.delayed.delete(cronId);
    if (!this.delayed.size) this.stopDelayReview();
    console.log(`[cron] "${entry.cronName}" held trigger cancelled by ${cancelledBy}`);
    emit('run:released', { ...entry, ran: false, reason: `cancelled by ${cancelledBy}` });
    return entry;
  }

  startDelayReview() {
    if (this.delayTimer) return;
    this.delayTimer = setInterval(() => {
      this.reviewDelays().catch((err) => console.error(`[cron] usage delay review failed: ${err.message}`));
    }, DELAY_REVIEW_MS);
    this.delayTimer.unref?.();
  }

  stopDelayReview() {
    if (this.delayTimer) clearInterval(this.delayTimer);
    this.delayTimer = null;
  }

  /**
   * Re-checks every waiting trigger and starts the ones whose limits have
   * cleared. The endpoint is only asked outside its normal window when a reset
   * time has actually passed — the rest of the time this reads the same cached
   * numbers the header meters draw.
   */
  async reviewDelays() {
    if (this.reviewing) return;
    if (!this.delayed.size) {
      this.stopDelayReview();
      return;
    }
    this.reviewing = true;
    try {
      const resetPassed = [...this.delayed.values()].some(
        (entry) => entry.resumeAt && Date.parse(entry.resumeAt) <= Date.now(),
      );
      const reading = resetPassed ? await usageMonitor.now() : await usageMonitor.state();

      for (const entry of [...this.delayed.values()]) {
        const cron = await getCron(entry.cronId);
        if (!cron) {
          this.delayed.delete(entry.cronId);
          emit('run:released', { ...entry, ran: false, reason: 'cron deleted' });
          continue;
        }
        // Deactivating a cron withdraws its schedule, so a scheduled trigger
        // still waiting has nothing left to belong to. A manual one is the
        // user's own press and still runs.
        if (!cron.isActive && entry.source === 'schedule') {
          this.delayed.delete(entry.cronId);
          console.log(`[cron] "${cron.name}" held trigger dropped: cron deactivated while waiting`);
          emit('run:released', { ...entry, ran: false, reason: 'cron deactivated while waiting' });
          continue;
        }

        const blockers = usageBlockers(reading, normalizeUsageDelay(cron.usageDelay));
        entry.checkedAt = new Date().toISOString();
        if (blockers.length) {
          // Still spent. The reasons are refreshed because the set can change:
          // a session limit resets while a weekly one is still holding it back.
          entry.reasons = blockers;
          entry.resumeAt = resumeTime(blockers);
          continue;
        }
        // A pause outranks this. The trigger keeps waiting and goes when the
        // pause lifts, which is also what resumeAll kicks off.
        if (this.pauseState) continue;

        this.delayed.delete(entry.cronId);
        if (this.running.has(entry.cronId)) {
          emit('run:skipped', { cronId: cron.id, cronName: cron.name, source: entry.source, reason: 'already running' });
          continue;
        }
        const waited = Date.now() - Date.parse(entry.delayedAt);
        console.log(`[cron] "${cron.name}" usage cleared after ${formatRuntime(waited)}; starting held ${entry.source} trigger`);
        emit('run:released', { ...entry, ran: true, reason: 'usage cleared' });
        await this.execute(cron, entry.source, { since: entry.delayedAt, reasons: entry.reasons });
      }
    } finally {
      this.reviewing = false;
      if (!this.delayed.size) this.stopDelayReview();
    }
  }

  /** Rebuilds every schedule from disk. Called on boot and after any cron write. */
  async reload() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();

    const crons = await listCrons();
    // Paused: the jobs above are stopped and none get rebuilt, so nothing fires.
    // Cron files can still be edited meanwhile; resuming re-reads them.
    if (this.pauseState) {
      console.log(`[cron] paused ${this.pauseState.label}; ${crons.length} cron(s) left unscheduled`);
      emit('crons:changed');
      return 0;
    }
    for (const cron of crons) {
      if (!cron.isActive) continue;
      const check = validateCronExpression(cron.cron);
      if (!check.ok) {
        console.error(`[cron] "${cron.name}" has an invalid expression (${cron.cron}): ${check.error}`);
        continue;
      }
      const job = new Cron(String(cron.cron).trim(), { name: cron.id }, () => {
        this.trigger(cron.id, 'schedule').catch((err) =>
          console.error(`[cron] "${cron.name}" failed to start: ${err.message}`),
        );
      });
      this.jobs.set(cron.id, job);
    }
    console.log(`[cron] scheduled ${this.jobs.size} of ${crons.length} cron(s)`);
    emit('crons:changed');
    return this.jobs.size;
  }

  nextRun(cronId) {
    const job = this.jobs.get(cronId);
    const next = job?.nextRun();
    return next ? next.toISOString() : null;
  }

  isRunning(cronId) {
    return this.running.has(cronId);
  }

  currentRun(cronId) {
    return this.running.get(cronId) ?? null;
  }

  /** True while a specific log file is being written by a live run. */
  isRunningLog(cronId, file) {
    return this.running.get(cronId)?.logFile === file;
  }

  /** Reads the cron fresh from disk, then runs it unless it is already in flight. */
  async trigger(cronId, source = 'manual') {
    const cron = await getCron(cronId);
    if (!cron) throw new Error('cron not found');
    // Schedules are stopped while paused, so this only catches a job that fired
    // in the moment before it was stopped. An update pause also blocks manual
    // runs, because the update is waiting for the last run to finish.
    if (this.pauseState && (source === 'schedule' || this.pauseState.mode === 'update')) {
      console.warn(`[cron] "${cron.name}" ${source} trigger skipped: paused ${this.pauseState.label}`);
      emit('run:skipped', { cronId, cronName: cron.name, source, reason: `paused ${this.pauseState.label}` });
      return null;
    }
    if (this.running.has(cronId)) {
      console.warn(`[cron] "${cron.name}" is still running; skipping ${source} trigger`);
      emit('run:skipped', { cronId, cronName: cron.name, source });
      return null;
    }
    // One waiting trigger per cron. A second one arriving while the first is
    // held is lost rather than queued behind it, so a cron that sits out a long
    // reset does not come back and fire a backlog.
    if (this.delayed.has(cronId)) {
      const waiting = this.delayed.get(cronId);
      console.warn(`[cron] "${cron.name}" already has a trigger held for usage; dropping the ${source} one`);
      emit('run:skipped', {
        cronId,
        cronName: cron.name,
        source,
        reason: `a trigger is already waiting on ${blockerNames(waiting.reasons)}`,
      });
      return null;
    }

    // Usage is read fresh here rather than from the cached meters: this is the
    // moment the run is decided, and a five-minute-old reading can be on the
    // wrong side of a reset. Run now goes through this too — it does not
    // override the setting, it joins the queue of one.
    const blockers = await this.blockersFor(cron, { fresh: true });
    if (blockers.length) return { delayed: this.hold(cron, source, blockers) };

    return this.execute(cron, source);
  }

  /**
   * Kills the in-flight run for a cron. The schedule is left alone, so an active
   * cron stays armed and fires again at its next trigger.
   */
  async stop(cronId, stoppedBy = 'user') {
    const run = this.running.get(cronId);
    const handle = this.handles.get(cronId);
    if (!run || !handle) return null;
    if (run.stopping) return run; // already asked; let the escalation finish

    run.stopping = true;
    run.stoppedBy = stoppedBy;
    handle.stream.write(`\n--- stop requested by ${stoppedBy} at ${new Date().toISOString()} ---\n`);

    // claude may have children of its own, so signal the whole process group.
    const { pid } = handle.child;
    const signal = (sig) => {
      try {
        process.kill(-pid, sig);
      } catch {
        try {
          handle.child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    signal('SIGTERM');
    handle.killTimer = setTimeout(() => {
      if (this.running.get(cronId) !== run) return; // it exited on its own
      handle.stream.write('\n--- still alive 5s after SIGTERM, sending SIGKILL ---\n');
      signal('SIGKILL');
    }, 5000);

    console.log(`[cron] "${run.cronName}" stop requested by ${stoppedBy} (pid ${pid})`);
    emit('run:stopping', { cronId, cronName: run.cronName, logFile: run.logFile });
    return run;
  }

  async execute(cron, source, held = null) {
    const startedAt = new Date();
    const dir = logDir(cron.name);
    await fsp.mkdir(dir, { recursive: true });

    const file = logFileName(startedAt);
    const fullPath = path.join(dir, file);
    const cwd = resolveUserPath(cron.workingDirectory) ?? os.homedir();
    // No model on the cron means whatever the CLI is configured to use.
    const modelArgs = cron.model?.trim() ? ['--model', cron.model.trim()] : [];
    // Same for effort: left off unless the cron names a level.
    const effortArgs = cron.effort?.trim() ? ['--effort', cron.effort.trim()] : [];

    const run = {
      runId: randomUUID(),
      cronId: cron.id,
      cronName: cron.name,
      logFile: file,
      startedAt: startedAt.toISOString(),
      source,
      pid: null,
      stopping: false,
      stoppedBy: null,
      // Set when this run is a trigger that sat out a usage limit, so the UI can
      // say the run went as soon as usage cleared.
      heldSince: held?.since ?? null,
    };
    this.running.set(cron.id, run);

    const stream = fs.createWriteStream(fullPath, { flags: 'a' });
    // Written once the child exists, so the header can carry its pid.
    const writeHeader = (pid) => {
      stream.write(
        [
          `=== ${cron.name} ===`,
          `started    ${startedAt.toISOString()}`,
          `pid        ${pid ?? '(not started)'}`,
          `trigger    ${source}`,
          `schedule   ${cron.cron}`,
          `directory  ${cwd}`,
          `model      ${cron.model?.trim() || '(CLI default)'}`,
          `effort     ${cron.effort?.trim() || '(CLI default)'}`,
          ...(held
            ? [`held       waited ${formatRuntime(startedAt - new Date(held.since))} for ${blockerNames(held.reasons ?? [])}`]
            : []),
          `command    ${CLAUDE_BIN} -p <prompt> ${[...CLAUDE_ARGS, ...modelArgs, ...effortArgs].join(' ')}`,
          '--- prompt ---',
          cron.prompt ?? '',
          '--- output ---',
          '',
        ].join('\n'),
      );
    };

    // Filled in from the CLI's final result event, when the run gets that far.
    let resultEvent = null;

    const finish = async (status, detail) => {
      const endedAt = new Date();
      const seconds = ((endedAt - startedAt) / 1000).toFixed(1);
      if (resultEvent) stream.write(statsBlock(resultEvent));
      await new Promise((resolve) => {
        stream.end(`\n--- ${status} after ${seconds}s${detail ? ` (${detail})` : ''} ---\n`, resolve);
      });
      const handle = this.handles.get(cron.id);
      if (handle?.killTimer) clearTimeout(handle.killTimer);
      this.handles.delete(cron.id);
      this.running.delete(cron.id);
      await patchCron(cron.id, {
        lastRunAt: startedAt.toISOString(),
        lastRunStatus: status,
        lastRunLog: file,
        lastRunDurationSeconds: Number(seconds),
      }).catch((err) => console.error(`[cron] could not record last run: ${err.message}`));
      const pruned = await pruneLogs(cron.name).catch((err) => {
        console.error(`[cron] log cleanup failed for "${cron.name}": ${err.message}`);
        return 0;
      });
      if (pruned) console.log(`[cron] pruned ${pruned} old log(s) for "${cron.name}"`);
      console.log(`[cron] "${cron.name}" ${status} in ${seconds}s -> ${file}`);
      emit('run:finished', { cronId: cron.id, cronName: cron.name, logFile: file, status, seconds: Number(seconds) });
    };

    const dirOk = await fsp
      .stat(cwd)
      .then((s) => s.isDirectory())
      .catch(() => false);
    if (!dirOk) {
      writeHeader(null);
      stream.write(`working directory not found: ${cwd}\n`);
      emit('run:started', run);
      await finish('failed', 'bad working directory');
      return run;
    }

    let child;
    try {
      child = spawn(CLAUDE_BIN, ['-p', promptFor(cron), ...CLAUDE_ARGS, ...modelArgs, ...effortArgs], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so stopping can signal claude and anything it spawned.
        detached: true,
      });
    } catch (err) {
      writeHeader(null);
      stream.write(`could not start ${CLAUDE_BIN}: ${err.message}\n`);
      emit('run:started', run);
      await finish('failed', 'spawn error');
      return run;
    }

    run.pid = child.pid;
    writeHeader(child.pid);
    this.handles.set(cron.id, { child, stream, killTimer: null });

    // stdout is newline-delimited JSON events; write through only the assistant's
    // text, so the log reads like plain output and can still be tailed live.
    let pending = '';
    let sawText = false;

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event;
      try {
        event = JSON.parse(trimmed);
      } catch {
        stream.write(`${line}\n`); // not JSON (a CLI warning); keep it verbatim
        return;
      }
      if (event.type === 'stream_event' && event.event?.type === 'content_block_delta') {
        const text = event.event.delta?.type === 'text_delta' ? event.event.delta.text : null;
        if (text) {
          sawText = true;
          stream.write(text);
        }
        return;
      }
      if (event.type === 'result') {
        resultEvent = event;
        // No deltas arrived (older CLI, or a non-streaming reply): fall back to the whole result.
        if (!sawText && typeof event.result === 'string' && event.result) stream.write(event.result);
        if (event.is_error) stream.write(`\nCLI reported an error: ${event.api_error_status ?? event.subtype ?? 'unknown'}\n`);
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? ''; // hold the incomplete tail for the next chunk
      for (const line of lines) handleLine(line);
    });
    child.stdout.on('end', () => {
      if (pending) handleLine(pending);
      pending = '';
    });

    child.stderr.pipe(stream, { end: false });

    child.on('error', (err) => {
      stream.write(`\nprocess error: ${err.message}\n`);
    });

    child.on('close', (code, signal) => {
      const status = run.stopping ? 'stopped' : code === 0 ? 'succeeded' : 'failed';
      const detail = run.stopping
        ? `killed by ${run.stoppedBy}${signal ? `, signal ${signal}` : ''}`
        : signal
          ? `signal ${signal}`
          : `exit code ${code}`;
      finish(status, detail).catch((err) => console.error(`[cron] finish failed: ${err.message}`));
    });

    console.log(`[cron] "${cron.name}" started (pid ${child.pid}, ${source}) -> ${file}`);
    emit('run:started', run);
    return run;
  }
}

export const cronService = new CronService();
