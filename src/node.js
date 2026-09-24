import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bus } from './events.js';
import { NODE_HOME, NODE_LOGS_DIR, NODE_TOKEN_FILE } from './paths.js';
import { cronService } from './cronService.js';
import {
  acknowledgePatches,
  flushJobCache,
  jobSettings,
  listCrons,
  listExecutions,
  loadJobCache,
  logDir,
  pendingPatches,
  replaceJobs,
} from './jobCache.js';
import { normalizeMaxConcurrentJobs } from './settings.js';
import { setUsageThresholds, usageMonitor } from './usage.js';
import { modelCatalog } from './models.js';
import { systemMonitor } from './system.js';

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HUB_URL = (process.env.PROMPTD_HUB_URL || `http://127.0.0.1:${process.env.PORT || 4321}`).replace(/\/+$/, '');
const HOSTNAME = os.hostname().replace(/\.local$/, '');
const NODE_ID = slug(process.env.PROMPTD_NODE_ID || HOSTNAME);
const NODE_NAME = process.env.PROMPTD_NODE_NAME || HOSTNAME;
const SYNC_MS = Number(process.env.PROMPTD_SYNC_MS) || 2000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_LOG_BYTES_PER_REPORT = 2 * 1024 * 1024;
const MAX_QUEUED_EVENTS = 2000;
const MAX_REMEMBERED_COMMANDS = 500;
const UPLOADS_FILE = path.join(NODE_HOME, 'uploads.json');
const INSTANCE = randomUUID();
const STARTED_AT = new Date().toISOString();

function slug(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'node'
  );
}

let events = [];
let commandResults = [];
const handledCommands = new Set();
const uploads = new Map();
let commit = null;
let reconciled = false;
let appliedPauseKey = null;
let lastError = null;

bus.on('event', (event) => {
  if (event.type === 'run:started' && event.logFile) {
    uploads.set(uploadKey(event.cronId, event.logFile), { jobId: event.cronId, file: event.logFile, offset: 0 });
    saveUploads();
  }
  events.push(event);
  if (events.length > MAX_QUEUED_EVENTS) events = events.slice(-MAX_QUEUED_EVENTS);
});

function uploadKey(jobId, file) {
  return `${jobId}/${file}`;
}

async function loadUploads() {
  try {
    for (const entry of JSON.parse(await fsp.readFile(UPLOADS_FILE, 'utf8'))) {
      uploads.set(uploadKey(entry.jobId, entry.file), entry);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[node] could not read ${UPLOADS_FILE}: ${err.message}`);
  }
}

function saveUploads() {
  const tmp = `${UPLOADS_FILE}.${process.pid}.tmp`;
  fsp
    .mkdir(NODE_HOME, { recursive: true })
    .then(() => fsp.writeFile(tmp, JSON.stringify([...uploads.values()]), 'utf8'))
    .then(() => fsp.rename(tmp, UPLOADS_FILE))
    .catch((err) => console.error(`[node] could not save ${UPLOADS_FILE}: ${err.message}`));
}

async function readToken() {
  if (process.env.PROMPTD_NODE_TOKEN) return process.env.PROMPTD_NODE_TOKEN.trim();
  try {
    return (await fsp.readFile(NODE_TOKEN_FILE, 'utf8')).trim();
  } catch {
    throw new Error(`no token: set PROMPTD_NODE_TOKEN, or run on the hub's machine where ${NODE_TOKEN_FILE} exists`);
  }
}

async function request(method, route, body) {
  const token = await readToken();
  const res = await fetch(`${HUB_URL}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-promptd-node': NODE_ID,
      'x-promptd-instance': INSTANCE,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`hub answered ${res.status}: ${payload.error ?? res.statusText}`);
  return payload;
}

function identity() {
  return {
    id: NODE_ID,
    name: NODE_NAME,
    instance: INSTANCE,
    hostname: os.hostname(),
    platform: process.platform,
    commit,
    startedAt: STARTED_AT,
  };
}

async function readLogChunks() {
  const chunks = [];
  let budget = MAX_LOG_BYTES_PER_REPORT;
  for (const [key, entry] of uploads) {
    if (budget <= 0) break;
    const file = path.join(logDir(entry.jobId), entry.file);
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const { size } = await handle.stat();
      if (size <= entry.offset) continue;
      const length = Math.min(size - entry.offset, budget);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, entry.offset);
      budget -= length;
      chunks.push({ jobId: entry.jobId, file: entry.file, offset: entry.offset, data: buffer.toString('base64') });
    } catch (err) {
      if (err.code === 'ENOENT') {
        uploads.delete(key);
        saveUploads();
      } else console.error(`[node] could not read ${file}: ${err.message}`);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  return chunks;
}

async function settleUploads(offsets = {}) {
  let changed = false;
  for (const [key, entry] of uploads) {
    if (Number.isFinite(offsets[key]) && offsets[key] !== entry.offset) {
      entry.offset = offsets[key];
      changed = true;
    }
    if (cronService.isRunningLog(entry.jobId, entry.file)) continue;
    const file = path.join(logDir(entry.jobId), entry.file);
    const size = await fsp
      .stat(file)
      .then((stat) => stat.size)
      .catch(() => null);
    if (size !== null && entry.offset < size) continue;
    uploads.delete(key);
    changed = true;
    await fsp.rm(file, { force: true }).catch(() => {});
  }
  if (changed) saveUploads();
}

async function jobViews() {
  const views = {};
  for (const cron of await listCrons()) {
    const nextRunAt = cronService.nextRun(cron.id);
    const delayed = cronService.delayInfo(cron.id);
    views[cron.id] = {
      nextRunAt,
      currentRun: cronService.currentRun(cron.id),
      delayed,
      delayRisk: nextRunAt && !delayed ? cronService.delayOutlook(cron, nextRunAt) : null,
    };
  }
  for (const execution of await listExecutions()) {
    const armed = execution.isActive && execution.status === 'scheduled';
    const delayed = cronService.delayInfo(execution.id);
    views[execution.id] = {
      nextRunAt: armed ? execution.scheduledAt : null,
      currentRun: cronService.currentRun(execution.id),
      delayed,
      delayRisk: armed && !delayed ? cronService.delayOutlook(execution, execution.scheduledAt) : null,
    };
  }
  for (const run of cronService.running.values()) {
    views[run.cronId] ??= { nextRunAt: null, currentRun: run, delayed: null, delayRisk: null };
  }
  return views;
}

async function status() {
  const { samples, ...system } = systemMonitor.state();
  return {
    pause: cronService.pauseInfo(),
    concurrency: cronService.concurrencyInfo(),
    counts: {
      scheduled: cronService.jobs.size,
      running: cronService.runningCount(),
      delayed: cronService.delayedCount(),
      queued: cronService.queuedCount(),
      usageDelayed: cronService.usageDelays().length,
      armedCrons: cronService.armedCrons,
      armedExecutions: cronService.armedExecutions,
      concurrencyLimit: cronService.concurrencyLimit,
    },
    jobs: await jobViews(),
    activeLogs: [...uploads.values()].map(({ jobId, file }) => ({ jobId, file })),
    usage: await usageMonitor.state(),
    models: modelCatalog.state(),
    system,
  };
}

async function report() {
  const patches = pendingPatches();
  const sentEvents = events.slice();
  const sentResults = commandResults.slice();
  const answer = await request('POST', '/api/node/report', {
    node: identity(),
    logs: await readLogChunks(),
    patches,
    events: sentEvents,
    commandResults: sentResults,
    status: await status(),
  });
  acknowledgePatches(patches.length);
  events = events.slice(sentEvents.length);
  commandResults = commandResults.slice(sentResults.length);
  await settleUploads(answer.logOffsets);
}

function applySettings(settings) {
  const limit = normalizeMaxConcurrentJobs(settings.maxConcurrentJobs);
  if (limit !== null) cronService.setConcurrencyLimit(limit);
  if (settings.usageDelayThresholds) setUsageThresholds(settings.usageDelayThresholds);
}

async function reconcileOnce() {
  if (reconciled) return;
  reconciled = true;
  await cronService.reconcileInterrupted().catch((err) => console.error(`[cron] reconcile failed: ${err.message}`));
}

async function applyPause(pause) {
  if (!pause) {
    appliedPauseKey = null;
    if (cronService.isPaused()) await cronService.resumeAll('lifted on the hub');
    return;
  }
  const key = `${pause.mode}:${pause.startedAt}`;
  if (key === appliedPauseKey && cronService.isPaused()) return;
  appliedPauseKey = key;
  await cronService.pauseAll({ mode: pause.mode, label: pause.label, option: pause.option, ms: null });
}

async function runCommand(command) {
  if (handledCommands.has(command.id)) return;
  handledCommands.add(command.id);
  if (handledCommands.size > MAX_REMEMBERED_COMMANDS) handledCommands.delete(handledCommands.values().next().value);
  try {
    let result = null;
    if (command.type === 'run') {
      const outcome = await cronService.trigger(command.jobId, 'manual');
      result = outcome?.delayed ? { delayed: outcome.delayed } : { started: Boolean(outcome) };
    } else if (command.type === 'stop') {
      const cancelled = await cronService.cancelDelay(command.jobId, 'user');
      if (!cancelled) await cronService.stop(command.jobId, 'user');
    } else if (command.type === 'refreshModels') {
      modelCatalog.refresh();
    } else {
      throw new Error(`unknown command ${command.type}`);
    }
    commandResults.push({ id: command.id, ok: true, result });
  } catch (err) {
    console.error(`[node] ${command.type} ${command.jobId ?? ''} failed: ${err.message}`);
    commandResults.push({ id: command.id, ok: false, error: err.message });
  }
}

async function fetchWork() {
  const work = await request('GET', '/api/node/work');
  const { jobsChanged, settingsChanged } = replaceJobs(work);
  if (settingsChanged) {
    applySettings(work.settings);
    cronService.reviewDelays().catch((err) => console.error(`[cron] usage delay review failed: ${err.message}`));
  }
  const firstRebuild = !reconciled;
  await reconcileOnce();
  if (jobsChanged || firstRebuild) await cronService.reload();
  await applyPause(work.pause);
  for (const command of work.commands ?? []) await runCommand(command);
}

async function cycle() {
  try {
    await report();
    await fetchWork();
    if (lastError) console.log(`[node] reconnected to ${HUB_URL}`);
    lastError = null;
  } catch (err) {
    const message = err.name === 'TimeoutError' ? 'request timed out' : err.cause?.code ?? err.message;
    if (message !== lastError) console.error(`[node] cannot sync with ${HUB_URL}: ${message}`);
    lastError = message;
  } finally {
    setTimeout(cycle, SYNC_MS);
  }
}

function readCommit() {
  return new Promise((resolve) => {
    execFile('git', ['-C', PROJECT_DIR, 'rev-parse', '--short', 'HEAD'], { timeout: 10000 }, (err, stdout) => {
      resolve(err ? null : String(stdout).trim() || null);
    });
  });
}

async function shutdown(signal) {
  console.log(`[node] ${signal}; saving state`);
  await flushJobCache().catch((err) => console.error(`[node] could not save state: ${err.message}`));
  await request('POST', '/api/node/leave', {}).catch(() => {});
  process.exit(0);
}

await fsp.mkdir(NODE_LOGS_DIR, { recursive: true });
await loadUploads();
commit = await readCommit();
if (await loadJobCache()) {
  applySettings(jobSettings());
  await reconcileOnce();
  await cronService.reload();
}
modelCatalog.refresh();
systemMonitor.start({ runningCrons: () => cronService.runningCrons() });
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
console.log(`promptd node "${NODE_NAME}" (${NODE_ID}) syncing with ${HUB_URL} every ${SYNC_MS}ms`);
cycle();
