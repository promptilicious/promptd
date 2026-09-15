import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { bus, sseInit, sseSend } from './events.js';
import { CRONS_DIR, LOGS_DIR, ROOT, ensureDirs, resolveUserPath } from './paths.js';
import { SETTINGS_FILE as SETTINGS_PATH } from './settings.js';
import {
  EFFORT_LEVELS,
  PAUSE_OPTIONS,
  cronService,
  isEffortLevel,
  pauseOption,
  previewNextRun,
  validateCronExpression,
} from './cronService.js';
import { cronFileWatcher } from './watcher.js';
import { modelCatalog } from './models.js';
import { loadSettings, patchSettings } from './settings.js';
import { checkForUpdates, currentCommit, selfUpdater, UPDATE_LOG, PROJECT_DIR } from './updater.js';
import { USAGE_DELAY_CATEGORIES, normalizeUsageDelay, usageMonitor } from './usage.js';
import {
  MAX_LOGS_PER_CRON,
  createCron,
  deleteCron,
  getCron,
  listCrons,
  listLogs,
  logPath,
  readLog,
  updateCron,
} from './store.js';

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

/** Validates and normalizes the cron form payload. */
function readForm(body) {
  const name = String(body?.name ?? '').trim();
  const expression = String(body?.cron ?? '').trim();
  const errors = [];
  if (!name) errors.push('Name is required.');
  if (name.length > 120) errors.push('Name must be 120 characters or fewer.');
  if (!expression) errors.push('Cron is required.');
  else {
    const check = validateCronExpression(expression);
    if (!check.ok) errors.push(`Cron expression is not valid: ${check.error}`);
  }
  if (!String(body?.prompt ?? '').trim()) errors.push('Prompt is required.');
  const effort = String(body?.effort ?? '').trim();
  if (effort && !isEffortLevel(effort)) {
    errors.push(`Effort must be one of ${EFFORT_LEVELS.map((level) => level.id).join(', ')}.`);
  }
  return {
    errors,
    value: {
      name,
      description: String(body?.description ?? '').trim(),
      cron: expression,
      workingDirectory: String(body?.workingDirectory ?? '').trim(),
      model: String(body?.model ?? '').trim(),
      effort,
      // Unknown keys are dropped and missing ones read as off, so the cron file
      // always carries the full set whatever the client sent.
      usageDelay: normalizeUsageDelay(body?.usageDelay),
      prompt: String(body?.prompt ?? ''),
      isActive: Boolean(body?.isActive),
    },
  };
}

function decorate(cron) {
  const run = cronService.currentRun(cron.id);
  const delayed = cronService.delayInfo(cron.id);
  return {
    ...cron,
    // Always the full set, so a cron file written before this setting existed
    // still answers every checkbox the form draws.
    usageDelay: normalizeUsageDelay(cron.usageDelay),
    nextRunAt: cronService.nextRun(cron.id),
    isRunning: Boolean(run),
    currentRun: run,
    isDelayed: Boolean(delayed),
    delayed,
  };
}

app.get('/api/config', (_req, res) => {
  // USAGE_DELAY_CATEGORIES carries its matcher functions; JSON.stringify drops
  // them, so the page receives exactly the id, label and hint it draws.
  res.json({
    storageRoot: ROOT,
    cronsDir: CRONS_DIR,
    logsDir: LOGS_DIR,
    maxLogsPerCron: MAX_LOGS_PER_CRON,
    effortLevels: EFFORT_LEVELS,
    usageDelayCategories: USAGE_DELAY_CATEGORIES,
  });
});

/**
 * Directory suggestions for the Working Directory field.
 * Splits what the user typed into an already-typed parent and a partial name,
 * then lists the parent's subdirectories that start with that partial.
 */
app.get('/api/browse', async (req, res, next) => {
  const typed = String(req.query.path ?? '');
  try {
    // Everything up to the last slash is settled; what follows is being typed.
    const cut = typed.lastIndexOf('/');
    const parentTyped = cut >= 0 ? typed.slice(0, cut + 1) : '~/';
    const partial = cut >= 0 ? typed.slice(cut + 1) : typed;
    const parentPath = resolveUserPath(parentTyped) ?? os.homedir();

    const entries = await fsp.readdir(parentPath, { withFileTypes: true }).catch(() => []);
    const wanted = partial.toLowerCase();
    const names = [];
    for (const entry of entries) {
      if (!entry.name.toLowerCase().startsWith(wanted)) continue;
      if (entry.name.startsWith('.') && !partial.startsWith('.')) continue;
      if (entry.isDirectory()) names.push(entry.name);
      else if (entry.isSymbolicLink()) {
        const isDir = await fsp
          .stat(path.join(parentPath, entry.name))
          .then((s) => s.isDirectory())
          .catch(() => false);
        if (isDir) names.push(entry.name);
      }
      if (names.length >= 200) break;
    }
    names.sort((a, b) => a.localeCompare(b));

    // Suggestions come back in the same style the user is typing, tilde included.
    const suggestions = names.slice(0, 25).map((name) => `${parentTyped}${name}/`);
    const resolved = resolveUserPath(typed);
    const exists = resolved
      ? await fsp
          .stat(resolved)
          .then((s) => s.isDirectory())
          .catch(() => false)
      : false;
    res.json({ suggestions, resolved, exists, truncated: names.length > 25 });
  } catch (err) {
    next(err);
  }
});

app.get('/api/settings', async (_req, res, next) => {
  try {
    res.json({ ...(await loadSettings()), settingsFile: SETTINGS_PATH, projectDir: PROJECT_DIR, updateLog: UPDATE_LOG });
  } catch (err) {
    next(err);
  }
});

/** Only the documented settings are writable; everything else stays as it is on disk. */
app.put('/api/settings', async (req, res, next) => {
  try {
    const patch = {};
    if ('selfUpdate' in (req.body ?? {})) patch.selfUpdate = Boolean(req.body.selfUpdate);
    if ('updateCheckIntervalHours' in (req.body ?? {})) {
      const hours = Number(req.body.updateCheckIntervalHours);
      if (!Number.isFinite(hours) || hours <= 0) return res.status(400).json({ error: 'updateCheckIntervalHours must be a positive number' });
      patch.updateCheckIntervalHours = hours;
    }
    res.json(await patchSettings(patch));
  } catch (err) {
    next(err);
  }
});

/**
 * Whole-app pause. Holding every schedule is a temporary state that is never
 * written to disk: a restart is one of the documented ways out of it.
 */
app.get('/api/pause', (_req, res) => {
  res.json({ ...cronService.pauseInfo(), options: PAUSE_OPTIONS, update: selfUpdater.state() });
});

app.post('/api/pause', async (req, res, next) => {
  try {
    if (cronService.isPausedForUpdate()) {
      return res.status(409).json({ error: 'an update is in progress; schedules are already held until it restarts' });
    }
    const option = pauseOption(String(req.body?.option ?? ''));
    if (!option) {
      return res.status(400).json({ error: `option must be one of ${PAUSE_OPTIONS.map((o) => o.id).join(', ')}` });
    }
    res.json(await cronService.pauseAll({ mode: 'manual', label: option.label, option: option.id, ms: option.ms }));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/pause', async (_req, res, next) => {
  try {
    if (cronService.isPausedForUpdate()) {
      return res.status(409).json({ error: 'this pause is holding schedules for an update and cannot be cancelled' });
    }
    if (!cronService.isPaused()) return res.status(409).json({ error: 'not paused' });
    res.json(await cronService.resumeAll('cancelled by user'));
  } catch (err) {
    next(err);
  }
});

/** Reports whether main is behind without touching the working tree. */
app.get('/api/update/check', async (_req, res, next) => {
  try {
    res.json(selfUpdater.recordCheck(await checkForUpdates()));
  } catch (err) {
    next(err);
  }
});

/**
 * Applies a pending update now. Works whether or not selfUpdate is on, which is
 * the point: it is how you update when you have chosen to do it by hand.
 */
app.post('/api/update/run', async (_req, res, next) => {
  try {
    const result = await selfUpdater.applyIfBehind();
    if (!result.launched) return res.status(409).json({ error: result.reason ?? 'nothing to update', ...result });
    res.status(202).json({ ...result, updateLog: UPDATE_LOG });
  } catch (err) {
    next(err);
  }
});

/** Models the installed CLI recognises, for the Model dropdown. */
app.get('/api/models', (_req, res) => {
  res.json(modelCatalog.state());
});

/** Re-runs discovery, e.g. after the CLI is updated. */
app.post('/api/models/refresh', async (_req, res, next) => {
  try {
    await modelCatalog.refresh();
    res.json(modelCatalog.state());
  } catch (err) {
    next(err);
  }
});

/** Live feedback for the Cron field: is this expression valid, and when does it next fire? */
app.get('/api/next-run', (req, res) => {
  const expression = String(req.query.cron ?? '').trim();
  if (!expression) return res.json({ valid: false, error: 'Cron is required.', nextRunAt: null });
  const check = validateCronExpression(expression);
  if (!check.ok) return res.json({ valid: false, error: check.error, nextRunAt: null });
  res.json({ valid: true, error: null, nextRunAt: previewNextRun(expression) });
});

app.get('/api/crons', async (_req, res, next) => {
  try {
    const crons = await listCrons();
    res.json(crons.map(decorate));
  } catch (err) {
    next(err);
  }
});

app.get('/api/crons/:id', async (req, res, next) => {
  try {
    const cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    res.json(decorate(cron));
  } catch (err) {
    next(err);
  }
});

app.post('/api/crons', async (req, res, next) => {
  try {
    const { errors, value } = readForm(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const cron = await createCron(value);
    await cronService.reload();
    res.status(201).json(decorate(cron));
  } catch (err) {
    next(err);
  }
});

app.put('/api/crons/:id', async (req, res, next) => {
  try {
    const { errors, value } = readForm(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const cron = await updateCron(req.params.id, value);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    await cronService.reload();
    res.json(decorate(cron));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/crons/:id', async (req, res, next) => {
  try {
    const removed = await deleteCron(req.params.id);
    if (!removed) return res.status(404).json({ error: 'cron not found' });
    await cronService.reload();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.post('/api/crons/:id/run', async (req, res, next) => {
  try {
    const cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    // Paused means nothing new starts, by hand or on a schedule — the same rule
    // the disabled Run now buttons show.
    if (cronService.isPaused()) {
      return res.status(409).json({
        error: cronService.isPausedForUpdate()
          ? 'an update is waiting for runs to finish; nothing new can start'
          : `all crons are paused ${cronService.pauseInfo().label}; cancel the pause to run one`,
      });
    }
    if (cronService.isDelayed(cron.id)) {
      return res.status(409).json({ error: 'a trigger for this cron is already waiting on usage' });
    }
    const result = await cronService.trigger(cron.id, 'manual');
    if (!result) return res.status(409).json({ error: 'this cron is already running' });
    // Run now does not override the usage delay setting: a blocked press becomes
    // the waiting trigger rather than starting claude anyway.
    if (result.delayed) return res.status(202).json({ delayed: result.delayed });
    res.status(202).json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/crons/:id/stop', async (req, res, next) => {
  try {
    const cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    // Stop is what the Run now button becomes while a trigger waits on usage, so
    // it has to end that wait as well as a live run.
    const cancelled = cronService.cancelDelay(cron.id, 'user');
    if (cancelled) return res.status(202).json({ cancelledDelay: cancelled, nextRunAt: cronService.nextRun(cron.id) });
    const run = await cronService.stop(cron.id, 'user');
    if (!run) return res.status(409).json({ error: 'this cron is not running' });
    // The schedule is untouched by a stop, so report when it next fires.
    res.status(202).json({ ...run, nextRunAt: cronService.nextRun(cron.id) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/crons/:id/logs', async (req, res, next) => {
  try {
    const cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    const logs = await listLogs(cron.name);
    res.json({
      cron: decorate(cron),
      logs: logs.map((log) => ({ ...log, isRunning: cronService.isRunningLog(cron.id, log.file) })),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/crons/:id/logs/:file', async (req, res, next) => {
  try {
    const cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    const text = await readLog(cron.name, req.params.file);
    res.json({ file: req.params.file, text, isRunning: cronService.isRunningLog(cron.id, req.params.file) });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'log not found' });
    if (err.message === 'invalid log file name') return res.status(400).json({ error: err.message });
    next(err);
  }
});

/**
 * Streams one log file: everything written so far, then each new chunk as it lands.
 * Polls the file size rather than using fs.watch, which is unreliable on macOS.
 */
app.get('/api/crons/:id/logs/:file/stream', async (req, res, next) => {
  let target;
  let cron;
  try {
    cron = await getCron(req.params.id);
    if (!cron) return res.status(404).json({ error: 'cron not found' });
    target = logPath(cron.name, req.params.file);
    await fsp.access(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'log not found' });
    if (err.message === 'invalid log file name') return res.status(400).json({ error: err.message });
    return next(err);
  }

  sseInit(res);
  let position = 0;
  let closed = false;
  let reading = false;

  const pump = async () => {
    if (closed || reading) return;
    reading = true;
    let handle;
    try {
      handle = await fsp.open(target, 'r');
      const { size } = await handle.stat();
      if (size > position) {
        const length = size - position;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, position);
        position = size;
        if (!closed) sseSend(res, 'chunk', { text: buffer.toString('utf8') });
      } else if (size < position) {
        // File was replaced or truncated; start over.
        position = 0;
      }
    } catch (err) {
      if (!closed) sseSend(res, 'error', { message: err.message });
    } finally {
      await handle?.close().catch(() => {});
      reading = false;
    }
  };

  const stop = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    res.end();
  };

  const tick = async () => {
    const live = cronService.isRunningLog(cron.id, req.params.file);
    await pump();
    if (!live && !closed) {
      sseSend(res, 'done', { file: req.params.file });
      stop();
    }
  };

  const timer = setInterval(() => {
    tick().catch(() => stop());
  }, 400);
  req.on('close', stop);
  await tick();
});

/** Fans out cron and run activity so the UI can update without polling. */
app.get('/api/events', (req, res) => {
  sseInit(res);
  sseSend(res, 'hello', { at: new Date().toISOString() });
  const onEvent = (event) => sseSend(res, event.type, event);
  bus.on('event', onEvent);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('event', onEvent);
  });
});

/**
 * The commit is read once at startup, not per request: it identifies the code
 * this process is running, which is what the page needs in order to notice that
 * an update has moved on without it.
 */
let runningCommit = null;

app.get('/api/health', async (_req, res) => {
  // Usage is cached and never rejects, so it cannot make the health check fail
  // or hang: the worst case is the reading being up to a minute old.
  const usage = await usageMonitor.state();
  res.json({
    ok: true,
    scheduled: cronService.jobs.size,
    commit: runningCommit,
    paused: cronService.isPaused(),
    delayed: cronService.delayedCount(),
    usage,
    ...selfUpdater.availability(),
  });
});

app.use((err, _req, res, _next) => {
  console.error('[server]', err);
  res.status(500).json({ error: err.message });
});

await ensureDirs();
await loadSettings(); // writes settings.json with defaults on first run
runningCommit = await currentCommit();
await cronService.reload();
await cronFileWatcher.start();
// Discovery spawns a probe per candidate model, so let it run behind the server
// coming up rather than delaying the first page load by several seconds.
modelCatalog.refresh();
selfUpdater.start();

app.listen(PORT, HOST, () => {
  console.log(`Claude Conductor listening on http://${HOST}:${PORT}${runningCommit ? ` (${runningCommit})` : ''}`);
  console.log(`Storage: ${ROOT}`);
});
