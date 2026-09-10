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

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

/**
 * Streaming JSON gives us the assistant text as it is produced plus a final
 * result event carrying the CLI's own usage accounting, which is the only
 * trustworthy source for tokens and cost.
 */
const CLAUDE_ARGS = ['--output-format', 'stream-json', '--verbose', '--include-partial-messages'];

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

class CronService {
  constructor() {
    /** @type {Map<string, Cron>} cron id -> scheduled job */
    this.jobs = new Map();
    /** @type {Map<string, object>} cron id -> in-flight run, JSON-safe for the API */
    this.running = new Map();
    /** @type {Map<string, object>} cron id -> child process and log stream, kept out of responses */
    this.handles = new Map();
  }

  /** Rebuilds every schedule from disk. Called on boot and after any cron write. */
  async reload() {
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
    if (this.running.has(cronId)) {
      console.warn(`[cron] "${cron.name}" is still running; skipping ${source} trigger`);
      emit('run:skipped', { cronId, cronName: cron.name, source });
      return null;
    }
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

  async execute(cron, source) {
    const startedAt = new Date();
    const dir = logDir(cron.name);
    await fsp.mkdir(dir, { recursive: true });

    const file = logFileName(startedAt);
    const fullPath = path.join(dir, file);
    const cwd = resolveUserPath(cron.workingDirectory) ?? os.homedir();
    // No model on the cron means whatever the CLI is configured to use.
    const modelArgs = cron.model?.trim() ? ['--model', cron.model.trim()] : [];

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
    };
    this.running.set(cron.id, run);

    const stream = fs.createWriteStream(fullPath, { flags: 'a' });
    const header = [
      `=== ${cron.name} ===`,
      `started    ${startedAt.toISOString()}`,
      `trigger    ${source}`,
      `schedule   ${cron.cron}`,
      `directory  ${cwd}`,
      `model      ${cron.model?.trim() || '(CLI default)'}`,
      `command    ${CLAUDE_BIN} -p <prompt> ${[...CLAUDE_ARGS, ...modelArgs].join(' ')}`,
      '--- prompt ---',
      cron.prompt ?? '',
      '--- output ---',
      '',
    ].join('\n');
    stream.write(header);

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
      stream.write(`working directory not found: ${cwd}\n`);
      emit('run:started', run);
      await finish('failed', 'bad working directory');
      return run;
    }

    let child;
    try {
      child = spawn(CLAUDE_BIN, ['-p', cron.prompt ?? '', ...CLAUDE_ARGS, ...modelArgs], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group, so stopping can signal claude and anything it spawned.
        detached: true,
      });
    } catch (err) {
      stream.write(`could not start ${CLAUDE_BIN}: ${err.message}\n`);
      emit('run:started', run);
      await finish('failed', 'spawn error');
      return run;
    }

    run.pid = child.pid;
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
