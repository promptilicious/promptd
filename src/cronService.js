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
import { getExecution, listExecutions, patchExecution } from './executions.js';
import { hasUsageDelay, normalizeUsageDelay, usageBlockers, usageMonitor } from './usage.js';
import { countRun } from './stats.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

// How often a trigger held for usage re-checks whether its limits have cleared.
// This costs nothing on its own — it reads the usage reading already in memory,
// and never asks the endpoint — so it is short enough to start the run promptly
// once a refresh lands rather than adding a wait of its own on top.
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

/** The prompt as the CLI receives it: the preamble, then what the job says. */
function promptFor(job) {
  const prompt = job.prompt ?? '';
  return prompt.trim() ? `${PROMPT_PREFIX}\n\n${prompt}` : PROMPT_PREFIX;
}

/**
 * The two kinds of thing this service runs, and where each is read and written.
 *
 * A cron and a one-time execution differ in when they fire and in nothing else:
 * the same prompt prefix, working directory, model, effort, usage delay, pause,
 * stop and statistics block apply to both. Everything below therefore works on
 * a "job" — a record carrying `kind` — rather than on a cron.
 */
const KINDS = {
  cron: { get: getCron, patch: patchCron },
  execution: { get: getExecution, patch: patchExecution },
};

/** Reads one job by id, whichever folder it lives in. Ids are unique across both. */
export async function findJob(id) {
  const cron = await getCron(id);
  if (cron) return { ...cron, kind: 'cron' };
  const execution = await getExecution(id);
  if (execution) return { ...execution, kind: 'execution' };
  return null;
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
    /**
     * Triggers dropped because every schedule is paused, counted per cron for
     * the current pause. A pause is missed time, not queued time, so this is
     * only ever a report of what did not run; it is reset by each new pause.
     * @type {Map<string, number>} cron id -> triggers dropped this pause
     */
    this.droppedDuringPause = new Map();
    /**
     * Ids between "this trigger was accepted" and "the child is spawned".
     *
     * `running` is only set once the process exists, and getting there means
     * reading the record and the usage numbers, so two triggers arriving in
     * that window would both pass the already-running check. A cron cannot do
     * that to itself — croner fires it once — but two writes in quick
     * succession each reload the schedules, and each reload starts whatever
     * one-time execution is overdue.
     * @type {Set<string>}
     */
    this.starting = new Set();
    /**
     * The rebuild queue. Rebuilds are chained rather than run concurrently,
     * because croner will not construct a job whose name is still taken.
     * @type {Promise|null}
     */
    this.reloading = null;
    /** Set while a catch-up pass is walking the overdue one-time executions. */
    this.catchingUp = false;
    /**
     * id -> a promise that settles when that run's log is closed. `execute`
     * resolves as soon as the child is spawned, so this is the only way to wait
     * for a run rather than for its process to exist.
     * @type {Map<string, Promise>}
     */
    this.completions = new Map();
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
      return { paused: false, mode: null, label: null, badge: null, until: null, startedAt: null, remainingMs: null, cancellable: false, runningCount: this.running.size, droppedCount: 0 };
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
      droppedCount: [...this.droppedDuringPause.values()].reduce((total, n) => total + n, 0),
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
    // Each pause reports its own missed triggers, not the last one's.
    this.droppedDuringPause.clear();
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
   * Which of this cron's watched limits are over their threshold, according to
   * the last usage reading.
   *
   * Always the cached reading, never a lookup of its own. The endpoint rate
   * limits and several Claude sessions on one machine share that limit, so a
   * held trigger rides the same one-per-five-minutes refresh the header meters
   * already drive rather than adding requests of its own. The cost is that a
   * limit which has just reset can read as spent for up to another refresh
   * window; the trigger waits that out.
   */
  async blockersFor(cron) {
    const delay = normalizeUsageDelay(cron.usageDelay);
    if (!hasUsageDelay(delay)) return [];
    let reading = await usageMonitor.state();
    // A cold start has nothing cached and state() does not wait on the lookup it
    // just started, so the first trigger would read no limits and sail past the
    // setting. Wait for that one request rather than send another.
    if (!reading.windows.length) reading = await usageMonitor.settled();
    return usageBlockers(reading, delay);
  }

  /** Parks a trigger until the limits it named clear. */
  hold(cron, source, blockers) {
    const now = new Date().toISOString();
    const entry = {
      cronId: cron.id,
      cronName: cron.name,
      kind: cron.kind ?? 'cron',
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
  async cancelDelay(cronId, cancelledBy = 'user') {
    const entry = this.delayed.get(cronId);
    if (!entry) return null;
    this.delayed.delete(cronId);
    if (!this.delayed.size) this.stopDelayReview();
    console.log(`[cron] "${entry.cronName}" held trigger cancelled by ${cancelledBy}`);
    // A cron's schedule fires again on its own, so dropping one trigger changes
    // nothing lasting. A one-time execution has no second trigger: leaving it
    // "scheduled" past its date would have the next rebuild treat it as overdue
    // and start the very run the user just cancelled. So this write is waited
    // on and its failure reported — answering "cancelled" over a write that
    // silently failed is how the cancel gets undone a few seconds later.
    if (entry.kind === 'execution') {
      const written = await patchExecution(cronId, { status: 'cancelled', stoppedBy: cancelledBy }).catch((err) => {
        console.error(`[cron] could not cancel "${entry.cronName}": ${err.message}`);
        return null;
      });
      if (!written) throw new Error('the waiting trigger was dropped, but the execution could not be marked cancelled; it may run again');
      emit('crons:changed');
    }
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
   * cleared.
   *
   * This reads the cached numbers the header meters draw and never asks the
   * endpoint out of turn. Asking is left to the refresh that reading is already
   * due for, so however many triggers are waiting, usage is still fetched at
   * most once per window. A trigger therefore goes within a refresh window of
   * its limit resetting rather than within seconds of it, which is the price of
   * not getting the account rate limited.
   */
  async reviewDelays() {
    if (this.reviewing) return;
    if (!this.delayed.size) {
      this.stopDelayReview();
      return;
    }
    this.reviewing = true;
    try {
      const reading = await usageMonitor.state();

      for (const entry of [...this.delayed.values()]) {
        const cron = await findJob(entry.cronId);
        if (!cron) {
          this.delayed.delete(entry.cronId);
          emit('run:released', { ...entry, ran: false, reason: 'cron deleted' });
          continue;
        }
        // Deactivating a cron withdraws its schedule, so a scheduled trigger
        // still waiting has nothing left to belong to. A manual one is the
        // user's own press and still runs.
        if (!cron.isActive && entry.source !== 'manual') {
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
          emit('run:skipped', { cronId: cron.id, cronName: cron.name, kind: cron.kind, source: entry.source, reason: 'already running' });
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

  /**
   * Rebuilds every schedule from disk — cron expressions and one-time
   * executions both. Called on boot and after any write to either folder.
   *
   * Runs one at a time. croner refuses to construct a job whose name is already
   * taken, and a rebuild yields three times while reading the two folders, so
   * two overlapping rebuilds would have the second one throw on the first name
   * the first had already claimed — leaving whatever it was called for
   * unscheduled. A run finishing now triggers one of these too, which is an
   * arbitrary moment and can land inside an API-driven one.
   */
  reload() {
    this.reloading = (this.reloading ?? Promise.resolve())
      // One rebuild failing must not poison the queue behind it.
      .catch(() => {})
      .then(() => this.rebuild());
    return this.reloading;
  }

  async rebuild() {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();

    const crons = await listCrons();
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

    const executions = await listExecutions();
    const overdue = this.armExecutions(executions);

    // Schedules stay registered through a pause, and every trigger they produce
    // is dropped on arrival by `trigger`. Nothing runs either way; the
    // difference is that a dropped trigger can be reported, and an unregistered
    // job cannot report the run it never started.
    console.log(
      this.pauseState
        ? `[cron] scheduled ${this.jobs.size} of ${crons.length + executions.length} job(s); paused ${this.pauseState.label}, so their triggers will be dropped`
        : `[cron] scheduled ${this.jobs.size} of ${crons.length + executions.length} job(s)`,
    );
    emit('crons:changed');
    if (overdue.length) {
      // Left to a microtask so this rebuild — and the pause or boot step that
      // asked for it — finishes before anything starts writing logs.
      queueMicrotask(() => {
        this.runOverdue().catch((err) => console.error(`[cron] overdue catch-up failed: ${err.message}`));
      });
    }
    return this.jobs.size;
  }

  /**
   * Arms the one-time executions that are still waiting, and answers with the
   * ones whose time has already passed.
   *
   * A timer is only for a future date; a date already gone gets no timer,
   * because croner would never fire it. Those come back as overdue and are run
   * on the spot — which is what makes a missed trigger survive a restart, and
   * what makes a pause that swallowed a trigger run it when the pause lifts.
   */
  armExecutions(executions) {
    const overdue = [];
    for (const execution of executions) {
      if (!execution.isActive || execution.status !== 'scheduled') continue;
      const at = Date.parse(execution.scheduledAt ?? '');
      if (!Number.isFinite(at)) {
        console.error(`[cron] one-time "${execution.name}" has an unreadable date (${execution.scheduledAt})`);
        continue;
      }
      if (at <= Date.now()) {
        overdue.push(execution);
        continue;
      }
      const job = new Cron(new Date(at), { name: execution.id }, () => {
        this.trigger(execution.id, 'schedule').catch((err) =>
          console.error(`[cron] one-time "${execution.name}" failed to start: ${err.message}`),
        );
      });
      this.jobs.set(execution.id, job);
    }
    return overdue;
  }

  /**
   * Runs the one-time executions whose trigger was missed, one at a time.
   *
   * One pass at a time, and one run at a time within it. Waiting on `trigger`
   * alone would not give that — it resolves once the child exists — so each run
   * is waited out to its closing line. And a run finishing rebuilds the
   * schedules, which asks for a catch-up of its own; without the single-flight
   * guard those passes interleave and the "one at a time" is only true of the
   * first two.
   *
   * The pass re-reads the folder each time round rather than walking a list
   * captured at the start, so a record that became overdue mid-pass is picked
   * up by the pass already running instead of needing one of its own. Each id
   * is attempted once, so a trigger that declines to start — parked on usage,
   * already running — ends the pass for that record rather than looping on it.
   *
   * Every run still goes through `trigger`, so the pause, the usage delay and
   * the already-running check all apply.
   */
  async runOverdue() {
    if (this.catchingUp) return 0;
    this.catchingUp = true;
    const attempted = new Set();
    let ran = 0;
    try {
      for (;;) {
        // The pause drops these on arrival, and lifting it rebuilds the
        // schedules — which finds them still overdue and runs them then.
        if (this.pauseState) return ran;
        const now = Date.now();
        const due = (await listExecutions()).filter((execution) => {
          if (attempted.has(execution.id)) return false;
          if (!execution.isActive || execution.status !== 'scheduled') return false;
          const at = Date.parse(execution.scheduledAt ?? '');
          return Number.isFinite(at) && at <= now;
        });
        if (!due.length) return ran;
        // Oldest miss first: the list comes back newest first.
        const execution = due.at(-1);
        attempted.add(execution.id);

        const late = formatRuntime(now - Date.parse(execution.scheduledAt));
        const result = await this.trigger(execution.id, 'missed').catch((err) => {
          console.error(`[cron] one-time "${execution.name}" catch-up failed: ${err.message}`);
          return null;
        });
        // Announced only once something is actually going. A catch-up parked on
        // a spent usage limit leaves the record `scheduled` with a past date, so
        // every later rebuild lists it as overdue again; announcing on sight
        // would write one unread "running now" notice per rebuild for a run that
        // has not started.
        if (!result || result.delayed) continue;
        ran += 1;
        console.log(`[cron] one-time "${execution.name}" missed its trigger by ${late}; running now`);
        emit('execution:overdue', {
          cronId: execution.id,
          cronName: execution.name,
          kind: 'execution',
          scheduledAt: execution.scheduledAt,
          lateBy: late,
        });
        await this.completions.get(execution.id)?.catch(() => {});
      }
    } finally {
      this.catchingUp = false;
    }
  }

  /**
   * A run the server was restarted out from under: the process died with the
   * child, so the record is left claiming to be running forever.
   *
   * Closed rather than restarted. The work may have been half done, and re-running
   * something destructive because the machine rebooted is worse than leaving it
   * for the Run now button. Called once at boot, before anything is armed.
   */
  async reconcileInterrupted() {
    const stranded = (await listExecutions()).filter((execution) => execution.status === 'running');
    for (const execution of stranded) {
      console.warn(`[cron] one-time "${execution.name}" was running when the server stopped; marking it interrupted`);
      await patchExecution(execution.id, {
        status: 'done',
        lastRunStatus: 'interrupted',
        // Dated by the run that was cut short, not left on the one before it:
        // a row reading "interrupted" beside "last ran: never" is a puzzle.
        lastRunAt: execution.firedAt ?? execution.lastRunAt ?? null,
        stoppedBy: 'server restart',
      }).catch((err) => console.error(`[cron] could not close "${execution.name}": ${err.message}`));
      emit('run:finished', {
        cronId: execution.id,
        cronName: execution.name,
        kind: 'execution',
        logFile: execution.lastRunLog ?? null,
        status: 'interrupted',
        // No footer was ever written, so there is no duration to report.
        seconds: null,
      });
    }
    return stranded.length;
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

  /**
   * What is in flight right now, name and start time each.
   *
   * Read by the machine-stat alerts: an alert that says the CPU is pinned is
   * half an answer, and this is the other half.
   */
  runningCrons() {
    return [...this.running.values()].map((run) => ({ name: run.cronName, kind: run.kind, startedAt: run.startedAt }));
  }

  /** True while a specific log file is being written by a live run. */
  isRunningLog(cronId, file) {
    return this.running.get(cronId)?.logFile === file;
  }

  /** Reads the job fresh from disk, then runs it unless it is already in flight. */
  async trigger(cronId, source = 'manual') {
    if (this.starting.has(cronId)) {
      console.warn(`[cron] ${cronId} is already starting; dropping the ${source} trigger`);
      return null;
    }
    this.starting.add(cronId);
    try {
      return await this.startTrigger(cronId, source);
    } finally {
      this.starting.delete(cronId);
    }
  }

  /** The body of `trigger`, run once per id at a time. */
  async startTrigger(cronId, source) {
    const cron = await findJob(cronId);
    if (!cron) throw new Error('cron not found');
    // A one-time execution fires once. Its timer can outlive its run — Run now
    // starts the run without rebuilding the schedules — so the record, not the
    // timer, is what says whether it still has a turn coming. A manual press is
    // the user asking again and always counts.
    if (cron.kind === 'execution' && source !== 'manual' && (!cron.isActive || cron.status !== 'scheduled')) {
      const why = cron.isActive ? cron.status : 'deactivated';
      console.warn(`[cron] one-time "${cron.name}" is ${why}; dropping the ${source} trigger`);
      emit('run:skipped', {
        cronId,
        cronName: cron.name,
        kind: cron.kind,
        source,
        reason: `it is ${why}, so it has no run left to make`,
      });
      return null;
    }
    // Schedules are stopped while paused, so this only catches a job that fired
    // in the moment before it was stopped. An update pause also blocks manual
    // runs, because the update is waiting for the last run to finish.
    if (this.pauseState && (source === 'schedule' || this.pauseState.mode === 'update')) {
      const dropped = (this.droppedDuringPause.get(cronId) ?? 0) + 1;
      this.droppedDuringPause.set(cronId, dropped);
      console.warn(`[cron] "${cron.name}" ${source} trigger dropped: paused ${this.pauseState.label}`);
      // Its own event rather than run:skipped: a pause drop is the one skip the
      // user did not ask for cron by cron, so it gets wording of its own.
      emit('run:dropped', {
        cronId,
        cronName: cron.name,
        kind: cron.kind,
        source,
        reason:
          this.pauseState.mode === 'update'
            ? 'an update is holding every schedule'
            : `all crons are paused ${this.pauseState.label}`,
        pauseMode: this.pauseState.mode,
        pauseLabel: this.pauseState.label,
        droppedCount: dropped,
        nextRunAt: this.nextRun(cronId),
      });
      return null;
    }
    if (this.running.has(cronId)) {
      console.warn(`[cron] "${cron.name}" is still running; skipping ${source} trigger`);
      emit('run:skipped', { cronId, cronName: cron.name, kind: cron.kind, source });
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
        kind: cron.kind,
        source,
        reason: `a trigger is already waiting on ${blockerNames(waiting.reasons)}`,
      });
      return null;
    }

    // Run now goes through this too: it does not override the setting, it joins
    // the queue of one.
    const blockers = await this.blockersFor(cron);
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
    // The log says who aborted it, and for a one-time execution the record says
    // so too — the log is pruned eventually, the record is what the list reads.
    handle.stream.write(`\n--- stop requested by ${stoppedBy} at ${new Date().toISOString()} ---\n`);
    if (run.kind === 'execution') {
      await patchExecution(cronId, { stoppedBy }).catch((err) =>
        console.error(`[cron] could not record the abort of "${run.cronName}": ${err.message}`),
      );
    }

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
    emit('run:stopping', { cronId, cronName: run.cronName, kind: run.kind, logFile: run.logFile });
    return run;
  }

  async execute(cron, source, held = null) {
    const kind = cron.kind ?? 'cron';
    const { get, patch } = KINDS[kind];
    const startedAt = new Date();
    const dir = logDir(cron.id);
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
      kind,
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
    // Settled by `finish`, once the log is closed and the record written. What
    // the overdue catch-up waits on so it starts one run at a time.
    let settle;
    this.completions.set(cron.id, new Promise((resolve) => {
      settle = resolve;
    }));
    if (kind === 'execution') {
      await patch(cron.id, { status: 'running', firedAt: startedAt.toISOString(), stoppedBy: null }).catch((err) =>
        console.error(`[cron] could not mark "${cron.name}" running: ${err.message}`),
      );
    }

    const stream = fs.createWriteStream(fullPath, { flags: 'a' });
    // Written once the child exists, so the header can carry its pid.
    const writeHeader = (pid) => {
      stream.write(
        [
          `=== ${cron.name} ===`,
          `started    ${startedAt.toISOString()}`,
          `pid        ${pid ?? '(not started)'}`,
          `trigger    ${source}`,
          kind === 'execution' ? `scheduled  ${cron.scheduledAt} (one-time)` : `schedule   ${cron.cron}`,
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
      // Read fresh rather than trusting the copy this run started with: a long
      // run can outlive the page visit that initialized these counters.
      const current = (await get(cron.id).catch(() => null)) ?? cron;
      const lifetime = await countRun(current, {
        status,
        seconds: Number(seconds),
        costUsd: resultEvent?.total_cost_usd,
      }).catch((err) => {
        console.error(`[cron] could not total lifetime stats: ${err.message}`);
        return {};
      });
      // A one-time execution has now had its one run. It stays in the list as
      // history and Run now still works, but nothing re-arms it — except a save
      // that moved its date while this run was going, which already put the
      // record back to `scheduled` and must not be written over here.
      const rescheduledMidRun = kind === 'execution' && current.status !== 'running';
      await patch(cron.id, {
        lastRunAt: startedAt.toISOString(),
        lastRunStatus: status,
        lastRunLog: file,
        lastRunDurationSeconds: Number(seconds),
        ...(kind === 'execution' && !rescheduledMidRun
          ? { status: 'done', stoppedBy: run.stopping ? run.stoppedBy : null }
          : {}),
        ...lifetime,
      }).catch((err) => console.error(`[cron] could not record last run: ${err.message}`));
      const pruned = await pruneLogs(cron.id).catch((err) => {
        console.error(`[cron] log cleanup failed for "${cron.name}": ${err.message}`);
        return 0;
      });
      if (pruned) console.log(`[cron] pruned ${pruned} old log(s) for "${cron.name}"`);
      console.log(`[cron] "${cron.name}" ${status} in ${seconds}s -> ${file}`);
      emit('run:finished', { cronId: cron.id, cronName: cron.name, kind, logFile: file, status, seconds: Number(seconds) });
      // The execution has had its run, so the one-shot timer it was armed with
      // is spent. Rebuild the schedules to drop it rather than leave something
      // counted as scheduled that the guard above would only refuse later — and
      // to arm the new date if the record was rescheduled while it ran.
      if (kind === 'execution') {
        await this.reload().catch((err) => console.error(`[cron] reload after run failed: ${err.message}`));
      }
      this.completions.delete(cron.id);
      settle(status);
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
