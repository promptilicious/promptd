import fsp from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { bus, sseInit, sseSend } from './events.js';
import { assertAuthConfigured, authRouter, requireLogin } from './auth.js';
import { databaseTarget, migrate, openDatabase } from './db.js';
import { importLegacyFiles } from './legacyImport.js';
import { LOGS_DIR, NODE_TOKEN_FILE, ROOT, ensureDirs, resolveUserPath } from './paths.js';
import { EFFORT_LEVELS, PAUSE_OPTIONS, isEffortLevel, pauseOption, previewNextRun, validateCronExpression } from './schedule.js';
import { hub } from './hub.js';
import {
  PAGE_SIZE as EXECUTIONS_PAGE_SIZE,
  createExecution,
  deleteExecution,
  getExecution,
  pageExecutions,
  parseScheduledAt,
  patchExecution,
  updateExecution,
} from './executions.js';
import { DEFAULT_MAX_CONCURRENT_JOBS, loadSettings, normalizeMaxConcurrentJobs, patchSettings } from './settings.js';
import { migrateLogDirs } from './logsMigration.js';
import { checkForUpdates, currentCommit, selfUpdater, UPDATE_LOG, PROJECT_DIR } from './updater.js';
import { USAGE_DELAY_CATEGORIES, normalizeUsageDelay, parseUsageThreshold, setUsageThresholds, usageDelayOptions } from './usage.js';
import { lifetimeStats } from './stats.js';
import { MAX_NOTIFICATIONS, PAGE_SIZE, notificationCenter } from './notifications.js';
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
import type { BusEvent, Cron, CronInput, Execution, ExecutionInput, JobKind, Settings } from './types.js';

/** When this process came up, which is what the Settings page calls the last boot. */
const STARTED_AT = new Date().toISOString();

const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

type JsonRequest = Request<Record<string, string>, unknown, Record<string, unknown>>;

type JobRequest = Request<{ kind: string; id: string }>;

type JobLogRequest = Request<{ kind: string; id: string; file: string }>;

interface FoundRecord {
  record: Cron | Execution;
  kind: JobKind;
  view(record: Cron | Execution): object;
}

function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined;
}

function errorMessage(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'message' in err ? err.message : undefined;
}

const app = express();
// Ahead of the page's body parser: a node's report carries log bytes and outgrows its limit.
app.use('/api/node', hub.router());
app.use(authRouter());
app.use(requireLogin());
app.get('/login', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

/** Validates and normalizes the cron form payload. */
function readForm(body: Record<string, unknown> | undefined): { errors: string[]; value: CronInput } {
  const name = String(body?.name ?? '').trim();
  const expression = String(body?.cron ?? '').trim();
  const errors: string[] = [];
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
      useWorktree: Boolean(body?.useWorktree),
      cleanupWorktree: Boolean(body?.cleanupWorktree),
      model: String(body?.model ?? '').trim(),
      effort,
      // Unknown keys are dropped and missing ones read as off, so the cron file
      // always carries the full set whatever the client sent.
      usageDelay: normalizeUsageDelay(body?.usageDelay),
      prompt: String(body?.prompt ?? ''),
      isActive: Boolean(body?.isActive),
      nodeId: String(body?.nodeId ?? '').trim(),
    },
  };
}

/**
 * Validates and normalizes the one-time execution form payload.
 *
 * The same fields as a cron, with a date where the expression was. A date
 * already in the past is accepted rather than rejected: the same rule that runs
 * a trigger missed over a restart runs this one as soon as it is saved, and a
 * form that refused it would be arguing with a clock the user can see.
 */
function readExecutionForm(body: Record<string, unknown> | undefined): { errors: string[]; value: ExecutionInput } {
  const name = String(body?.name ?? '').trim();
  const errors: string[] = [];
  if (!name) errors.push('Name is required.');
  if (name.length > 120) errors.push('Name must be 120 characters or fewer.');
  const scheduledAt = parseScheduledAt(body?.scheduledAt);
  if (!String(body?.scheduledAt ?? '').trim()) errors.push('Date and time are required.');
  else if (!scheduledAt) errors.push('Date and time is not a valid date.');
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
      // Stored as UTC ISO, whatever the browser sent, so the record reads the
      // same wherever it is opened from.
      scheduledAt: scheduledAt ? scheduledAt.toISOString() : null,
      workingDirectory: String(body?.workingDirectory ?? '').trim(),
      useWorktree: Boolean(body?.useWorktree),
      // Whatever was sent: a job that runs once would only leave its worktree behind.
      cleanupWorktree: true,
      model: String(body?.model ?? '').trim(),
      effort,
      usageDelay: normalizeUsageDelay(body?.usageDelay),
      prompt: String(body?.prompt ?? ''),
      isActive: Boolean(body?.isActive),
      nodeId: String(body?.nodeId ?? '').trim(),
    },
  };
}

function decorate(cron: Cron) {
  const view = hub.jobView(cron);
  return {
    ...cron,
    // Always the full set, so a cron file written before this setting existed
    // still answers every checkbox the form draws.
    usageDelay: normalizeUsageDelay(cron.usageDelay),
    node: hub.nodeSummary(cron),
    nextRunAt: view?.nextRunAt ?? null,
    isRunning: Boolean(view?.currentRun),
    currentRun: view?.currentRun ?? null,
    isDelayed: Boolean(view?.delayed),
    delayed: view?.delayed ?? null,
    delayRisk: view?.delayRisk ?? null,
  };
}

/**
 * One execution, as the page draws it. `nextRunAt` is the schedule it is still
 * waiting on, so a record that has already run — or been cancelled — reports
 * none, whatever its date says.
 */
function decorateExecution(execution: Execution) {
  const view = hub.jobView(execution);
  const armed = execution.isActive && execution.status === 'scheduled';
  return {
    ...execution,
    kind: 'execution',
    usageDelay: normalizeUsageDelay(execution.usageDelay),
    node: hub.nodeSummary(execution),
    nextRunAt: armed ? execution.scheduledAt : null,
    // Its time has passed and nothing has run it. On the page that is the gap
    // between the trigger being missed and the catch-up starting the run.
    isOverdue: armed && Date.parse(execution.scheduledAt ?? '') <= Date.now(),
    isRunning: Boolean(view?.currentRun),
    currentRun: view?.currentRun ?? null,
    isDelayed: Boolean(view?.delayed),
    delayed: view?.delayed ?? null,
    delayRisk: view?.delayRisk ?? null,
  };
}

/** What the route was asked about, for an error message a person reads. */
function noun(req: Request): string {
  return req.params.kind === 'executions' ? 'execution' : 'cron';
}

/** Either kind by id, with the routes and helpers each one needs. */
async function findRecord(id: string): Promise<FoundRecord | null> {
  const cron = await getCron(id);
  if (cron) return { record: cron, kind: 'cron', view: decorate };
  const execution = await getExecution(id);
  if (execution) return { record: execution, kind: 'execution', view: decorateExecution };
  return null;
}

app.get('/api/config', (_req, res) => {
  res.json({
    storageRoot: ROOT,
    database: databaseTarget(),
    logsDir: LOGS_DIR,
    maxLogsPerCron: MAX_LOGS_PER_CRON,
    maxNotifications: MAX_NOTIFICATIONS,
    effortLevels: EFFORT_LEVELS,
    // Each with the threshold in force now, which the form draws next to its label.
    usageDelayCategories: usageDelayOptions(),
    // What the concurrent job limit defaults to, so the Settings page can say
    // what "processors" means on this machine.
    defaultMaxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
  });
});

/**
 * One page of notifications, newest first. `before` is the id of the last one
 * already shown rather than an offset: new notices arrive while the list is
 * open, and an offset would show one of them a second time.
 */
app.get('/api/notifications', async (req, res, next) => {
  try {
    const before = String(req.query.before ?? '').trim() || null;
    // `?unread=1` is the drawer's filter: the same pages with the read ones left out.
    const unreadOnly = ['1', 'true', 'yes'].includes(String(req.query.unread ?? '').toLowerCase());
    res.json(await notificationCenter.page({ before, limit: req.query.limit ?? PAGE_SIZE, unreadOnly }));
  } catch (err) {
    next(err);
  }
});

/**
 * Marks what the reader has actually had on screen. Body `{"ids":[...]}`, or
 * `{"all":true}` for the drawer's "Mark all read" button.
 */
app.post('/api/notifications/read', async (req: JsonRequest, res, next) => {
  try {
    if (req.body?.all === true) return res.json(await notificationCenter.markAllRead());
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    if (!ids.length) return res.status(400).json({ error: 'ids must be a non-empty array' });
    res.json(await notificationCenter.markRead(ids));
  } catch (err) {
    next(err);
  }
});

/** The default node's machine stats, from its reports. */
app.get('/api/system', (_req, res) => {
  res.json(hub.systemState());
});

app.get('/api/nodes', (_req, res) => {
  res.json({ nodes: hub.listNodes(), defaultNodeId: hub.defaultNodeId(), tokenFile: NODE_TOKEN_FILE });
});

app.delete('/api/nodes/:id', (req, res) => {
  const result = hub.forgetNode(req.params.id);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true });
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
    const names: string[] = [];
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
    res.json({ ...(await loadSettings()), database: databaseTarget(), projectDir: PROJECT_DIR, updateLog: UPDATE_LOG });
  } catch (err) {
    next(err);
  }
});

/** Only the documented settings are writable; everything else stays as it is on disk. */
app.put('/api/settings', async (req: JsonRequest, res, next) => {
  try {
    const patch: Partial<Settings> = {};
    if ('serverName' in (req.body ?? {})) {
      if (typeof req.body.serverName !== 'string') return res.status(400).json({ error: 'serverName must be a string' });
      patch.serverName = req.body.serverName.trim();
    }
    if ('serverColor' in (req.body ?? {})) {
      const color = typeof req.body.serverColor === 'string' ? req.body.serverColor.trim().toLowerCase() : null;
      if (color === null || (color && !/^#[0-9a-f]{6}$/.test(color))) {
        return res.status(400).json({ error: 'serverColor must be a #rrggbb color, or blank for the default' });
      }
      patch.serverColor = color;
    }
    if ('selfUpdate' in (req.body ?? {})) patch.selfUpdate = Boolean(req.body.selfUpdate);
    if ('updateCheckIntervalHours' in (req.body ?? {})) {
      const hours = Number(req.body.updateCheckIntervalHours);
      if (!Number.isFinite(hours) || hours <= 0) return res.status(400).json({ error: 'updateCheckIntervalHours must be a positive number' });
      patch.updateCheckIntervalHours = hours;
    }
    if ('maxConcurrentJobs' in (req.body ?? {})) {
      const limit = normalizeMaxConcurrentJobs(req.body.maxConcurrentJobs);
      if (limit === null) return res.status(400).json({ error: 'maxConcurrentJobs must be 0 or a positive whole number' });
      patch.maxConcurrentJobs = limit;
    }
    if ('usageDelayThresholds' in (req.body ?? {})) {
      // Any subset of the categories; the ones left out keep what is on disk.
      const given = (req.body.usageDelayThresholds ?? {}) as Record<string, unknown>;
      const thresholds = { ...(await loadSettings()).usageDelayThresholds };
      for (const category of USAGE_DELAY_CATEGORIES) {
        if (!(category.id in given)) continue;
        const value = parseUsageThreshold(given[category.id]);
        if (value === null) {
          return res.status(400).json({ error: `usageDelayThresholds.${category.id} must be a whole number from 1 to 100` });
        }
        thresholds[category.id] = value;
      }
      patch.usageDelayThresholds = thresholds;
    }
    if ('defaultWorkingDirectory' in (req.body ?? {})) {
      if (typeof req.body.defaultWorkingDirectory !== 'string') return res.status(400).json({ error: 'defaultWorkingDirectory must be a string' });
      // Blank would run in home anyway; saved as ~/ so a new job's field still shows where it starts.
      patch.defaultWorkingDirectory = req.body.defaultWorkingDirectory.trim() || '~/';
    }
    if ('defaultPrompt' in (req.body ?? {})) {
      if (typeof req.body.defaultPrompt !== 'string') return res.status(400).json({ error: 'defaultPrompt must be a string' });
      patch.defaultPrompt = req.body.defaultPrompt;
    }
    if ('commonCommands' in (req.body ?? {})) {
      if (typeof req.body.commonCommands !== 'string') return res.status(400).json({ error: 'commonCommands must be a string' });
      // Saved sorted, one per line, with blank lines dropped.
      patch.commonCommands = req.body.commonCommands
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .join('\n');
    }
    if ('defaultWorktreeInclude' in (req.body ?? {})) {
      if (typeof req.body.defaultWorktreeInclude !== 'string') return res.status(400).json({ error: 'defaultWorktreeInclude must be a string' });
      patch.defaultWorktreeInclude = req.body.defaultWorktreeInclude;
    }
    if ('defaultNodeId' in (req.body ?? {})) {
      const id = String(req.body.defaultNodeId ?? '').trim();
      if (!hub.nodes.has(id)) return res.status(400).json({ error: 'defaultNodeId must be a node that has connected' });
      patch.defaultNodeId = id;
    }
    const saved = await patchSettings(patch);
    // Written first, applied second: nodes pick settings up from memory, so a
    // save that did not reach the disk must not change what is running.
    hub.setSettings(saved);
    if ('usageDelayThresholds' in patch) setUsageThresholds(saved.usageDelayThresholds);
    if ('defaultNodeId' in patch) hub.jobsChanged();
    res.json(saved);
  } catch (err) {
    next(err);
  }
});

/**
 * The concurrent job limit, what is running under it, and what is queued behind
 * it — with the estimated start time of each waiting trigger.
 *
 * Answered from memory: the queue is never written to disk, for the same reason
 * the pause is not. A restart comes back with nothing waiting.
 */
app.get('/api/queue', (_req, res) => {
  res.json(hub.concurrencyInfo());
});

/**
 * Whole-app pause. Holding every schedule is a temporary state that is never
 * written to disk: a restart is one of the documented ways out of it.
 */
app.get('/api/pause', (_req, res) => {
  res.json({ ...hub.pauseInfo(), options: PAUSE_OPTIONS, update: selfUpdater.state() });
});

app.post('/api/pause', async (req: JsonRequest, res, next) => {
  try {
    if (hub.isPausedForUpdate()) {
      return res.status(409).json({ error: 'an update is in progress; schedules are already held until it restarts' });
    }
    const option = pauseOption(String(req.body?.option ?? ''));
    if (!option) {
      return res.status(400).json({ error: `option must be one of ${PAUSE_OPTIONS.map((o) => o.id).join(', ')}` });
    }
    res.json(await hub.pauseAll({ mode: 'manual', label: option.label, option: option.id, ms: option.ms }));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/pause', async (_req, res, next) => {
  try {
    if (hub.isPausedForUpdate()) {
      return res.status(409).json({ error: 'this pause is holding schedules for an update and cannot be cancelled' });
    }
    if (!hub.isPaused()) return res.status(409).json({ error: 'not paused' });
    res.json(await hub.resumeAll('cancelled by user'));
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

/** Models the default node's CLI recognises, for the Model dropdown. */
app.get('/api/models', (_req, res) => {
  res.json(hub.models());
});

/** Re-runs discovery, e.g. after the CLI is updated. */
app.post('/api/models/refresh', async (_req, res, next) => {
  try {
    res.json(await hub.refreshModels());
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
    hub.jobsChanged();
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
    hub.jobsChanged();
    res.json(decorate(cron));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/crons/:id', async (req, res, next) => {
  try {
    const removed = await deleteCron(req.params.id);
    if (!removed) return res.status(404).json({ error: 'cron not found' });
    hub.jobsChanged();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * One page of one-time executions, newest first, with the same cursor the
 * notification drawer uses.
 */
app.get('/api/executions', async (req, res, next) => {
  try {
    const before = String(req.query.before ?? '').trim() || null;
    const page = await pageExecutions({ before, limit: req.query.limit ?? EXECUTIONS_PAGE_SIZE });
    res.json({ ...page, items: page.items.map(decorateExecution) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/executions/:id', async (req, res, next) => {
  try {
    const execution = await getExecution(req.params.id);
    if (!execution) return res.status(404).json({ error: 'execution not found' });
    res.json(decorateExecution(execution));
  } catch (err) {
    next(err);
  }
});

app.post('/api/executions', async (req, res, next) => {
  try {
    const { errors, value } = readExecutionForm(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const execution = await createExecution(value);
    // A date already past is armed and run by the same reload that arms the
    // rest, so saving one is how you say "run this now, behind the queue".
    hub.jobsChanged();
    res.status(201).json(decorateExecution(execution));
  } catch (err) {
    next(err);
  }
});

app.put('/api/executions/:id', async (req, res, next) => {
  try {
    const { errors, value } = readExecutionForm(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' ') });
    const execution = await updateExecution(req.params.id, value);
    if (!execution) return res.status(404).json({ error: 'execution not found' });
    hub.jobsChanged();
    res.json(decorateExecution(execution));
  } catch (err) {
    next(err);
  }
});

app.delete('/api/executions/:id', async (req, res, next) => {
  try {
    const removed = await deleteExecution(req.params.id);
    if (!removed) return res.status(404).json({ error: 'execution not found' });
    hub.jobsChanged();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * Re-arms a one-time execution that has run, been cancelled, or was closed as
 * interrupted, without changing its date. What the list's "Reschedule" offers
 * when the date is still in the future.
 */
app.post('/api/executions/:id/rearm', async (req, res, next) => {
  try {
    const execution = await getExecution(req.params.id);
    if (!execution) return res.status(404).json({ error: 'execution not found' });
    if (execution.status === 'running') return res.status(409).json({ error: 'this execution is running' });
    const rearmed = await patchExecution(req.params.id, { status: 'scheduled', firedAt: null, stoppedBy: null });
    hub.jobsChanged();
    res.json(decorateExecution(rearmed!));
  } catch (err) {
    next(err);
  }
});

app.post('/api/:kind(crons|executions)/:id/run', async (req: JobRequest, res, next) => {
  try {
    const found = await findRecord(req.params.id);
    if (!found) return res.status(404).json({ error: `${noun(req)} not found` });
    const job = found.record;
    // Paused means nothing new starts, by hand or on a schedule — the same rule
    // the disabled Run now buttons show.
    if (hub.isPaused()) {
      return res.status(409).json({
        error: hub.isPausedForUpdate()
          ? 'an update is waiting for runs to finish; nothing new can start'
          : `everything is paused ${hub.pauseInfo().label}; cancel the pause to run one`,
      });
    }
    const node = hub.nodeSummary(job);
    const view = hub.jobView(job);
    if (!node.online) return res.status(409).json({ error: `node "${node.name ?? 'default'}" is offline` });
    if (view?.currentRun) return res.status(409).json({ error: `this ${noun(req)} is already running` });
    if (view?.delayed) {
      return res.status(409).json({
        error:
          view.delayed.hold === 'concurrency'
            ? `a trigger for this ${noun(req)} is already queued behind the ${view.delayed.limit} job limit`
            : `a trigger for this ${noun(req)} is already waiting on usage`,
      });
    }
    hub.command(node.id!, 'run', job.id);
    res.status(202).json({ requested: true, node });
  } catch (err) {
    next(err);
  }
});

app.post('/api/:kind(crons|executions)/:id/stop', async (req: JobRequest, res, next) => {
  try {
    const found = await findRecord(req.params.id);
    if (!found) return res.status(404).json({ error: `${noun(req)} not found` });
    const job = found.record;
    const node = hub.nodeSummary(job);
    const view = hub.jobView(job);
    if (!view?.currentRun && !view?.delayed) return res.status(409).json({ error: `this ${noun(req)} is not running` });
    hub.command(node.id!, 'stop', job.id);
    res.status(202).json({ requested: true, node, nextRunAt: view.nextRunAt ?? null });
  } catch (err) {
    next(err);
  }
});

/**
 * The run history of one job. Crons and one-time executions write into the same
 * logs folder, each under its own id, so this route serves both — only where the
 * lifetime totals are written back differs.
 */
app.get('/api/:kind(crons|executions)/:id/logs', async (req: JobRequest, res, next) => {
  try {
    const found = await findRecord(req.params.id);
    if (!found) return res.status(404).json({ error: `${noun(req)} not found` });
    const cron = found.record;
    const logs = await listLogs(cron.id);
    // Read here rather than on the cron list: the first read scans the log
    // folder, and this is the one page that draws the result.
    const stats = await lifetimeStats(cron, found.kind === 'execution' ? patchExecution : undefined);
    hub.jobsCache = null;
    res.json({
      cron: found.view(cron),
      stats,
      logs: logs.map((log) => ({ ...log, isRunning: hub.isRunningLog(cron.id, log.file) })),
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/:kind(crons|executions)/:id/logs/:file', async (req: JobLogRequest, res, next) => {
  try {
    const cron = await findRecord(req.params.id).then((found) => found?.record ?? null);
    if (!cron) return res.status(404).json({ error: `${noun(req)} not found` });
    const text = await readLog(cron.id, req.params.file);
    res.json({ file: req.params.file, text, isRunning: hub.isRunningLog(cron.id, req.params.file) });
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return res.status(404).json({ error: 'log not found' });
    if (errorMessage(err) === 'invalid log file name') return res.status(400).json({ error: errorMessage(err) });
    next(err);
  }
});

/**
 * Streams one log file: everything written so far, then each new chunk as it lands.
 * Polls the file size rather than using fs.watch, which is unreliable on macOS.
 */
app.get('/api/:kind(crons|executions)/:id/logs/:file/stream', async (req: JobLogRequest, res, next) => {
  let target: string;
  let cron: Cron | Execution | null;
  try {
    cron = await findRecord(req.params.id).then((found) => found?.record ?? null);
    if (!cron) return res.status(404).json({ error: `${noun(req)} not found` });
    target = logPath(cron.id, req.params.file);
    await fsp.access(target);
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return res.status(404).json({ error: 'log not found' });
    if (errorMessage(err) === 'invalid log file name') return res.status(400).json({ error: errorMessage(err) });
    return next(err);
  }

  sseInit(res);
  let position = 0;
  let closed = false;
  let reading = false;

  const pump = async () => {
    if (closed || reading) return;
    reading = true;
    let handle: FileHandle | undefined;
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
      if (!closed) sseSend(res, 'error', { message: errorMessage(err) });
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
    const live = hub.isRunningLog(cron.id, req.params.file);
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
  const onEvent = (event: BusEvent): void => sseSend(res, event.type, event);
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
let runningCommit: string | null = null;

app.get('/api/health', async (_req, res) => {
  if (res.locals.signedIn === false) return res.json({ ok: true, authRequired: true });
  // The one await that can be slow, and only once: the folder is read at
  // startup, and every poll after that is answered from memory.
  await notificationCenter.ready;
  res.json({
    ok: true,
    ...hub.health(),
    commit: runningCommit,
    startedAt: STARTED_AT,
    // What the limit means when it is 0: the header's jobs meter fills against
    // this rather than against "unlimited", which no bar can draw.
    defaultConcurrencyLimit: DEFAULT_MAX_CONCURRENT_JOBS,
    unreadNotifications: notificationCenter.unreadCount(),
    ...selfUpdater.availability(),
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server]', err);
  res.status(500).json({ error: errorMessage(err) });
});

await ensureDirs();
openDatabase();
await migrate();
try {
  await assertAuthConfigured(HOST);
} catch (err) {
  console.error(`[auth] ${errorMessage(err)}`);
  process.exit(1);
}
// Before the first settings read, which would otherwise write defaults over
// an install that still has its settings.json.
await importLegacyFiles();
// Subscribes to the event bus before anything can emit, and reads the table
// behind the server coming up.
notificationCenter.start();
const bootSettings = await loadSettings(); // writes the defaults on first run
setUsageThresholds(bootSettings.usageDelayThresholds);
// Before any node can upload a log: after this the folders are cron ids.
await migrateLogDirs().catch((err: unknown) => console.error(`[logs] migration failed: ${errorMessage(err)}`));
runningCommit = await currentCommit();
await hub.start(await loadSettings());
selfUpdater.start();

app.listen(PORT, HOST, () => {
  console.log(`promptd listening on http://${HOST}:${PORT}${runningCommit ? ` (${runningCommit})` : ''}`);
  const database = databaseTarget();
  console.log(`Storage: ${ROOT}; ${database.dialect} database at ${database.location}`);
  hub.ensureLocalNodeAgent().catch((err: unknown) => console.error(`[hub] local node agent check failed: ${errorMessage(err)}`));
});
