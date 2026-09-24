import fsp from 'node:fs/promises';
import path from 'node:path';
import { NODE_HOME, NODE_LOGS_DIR } from './paths.js';
import { safeName } from './store.js';
import { byScheduledAtDesc } from './executions.js';
import { countRun as countFromRecord, hasLifetimeStats } from './stats.js';

/**
 * Stands in for the hub's store under the same names, so the cron service reads
 * and writes jobs exactly as it did when it owned the files. A write lands in
 * the copy at once and waits in the outbox until a report carries it to the hub.
 */

const STATE_FILE = path.join(NODE_HOME, 'state.json');
const SAVE_DELAY_MS = 500;

const records = { cron: new Map(), execution: new Map() };
let settings = {};
let outbox = [];
let saveTimer = null;

const clone = (value) => (value ? structuredClone(value) : null);

export async function getCron(id) {
  return clone(records.cron.get(id));
}

export async function getExecution(id) {
  return clone(records.execution.get(id));
}

export async function listCrons() {
  return [...records.cron.values()].map(clone).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function listExecutions() {
  return [...records.execution.values()].map(clone).sort(byScheduledAtDesc);
}

function patch(kind, id, fields) {
  const existing = records[kind].get(id);
  const merged = { ...(existing ?? { id }), ...fields };
  // A job the hub has since taken away still has its run recorded, but it is not
  // put back into the copy, where it would be armed again.
  if (existing) records[kind].set(id, merged);
  outbox.push({ kind, id, patch: fields });
  scheduleSave();
  return clone(merged);
}

export async function patchCron(id, fields) {
  return patch('cron', id, fields);
}

export async function patchExecution(id, fields) {
  return patch('execution', id, fields);
}

export function jobSettings() {
  return settings;
}

export function logDir(jobId) {
  return path.join(NODE_LOGS_DIR, safeName(jobId));
}

/**
 * The lifetime counters to add for a finished run. A record with no counters yet
 * is backfilled by the hub from the logs it holds, so the node adds nothing.
 */
export async function countRun(job, run) {
  if (!hasLifetimeStats(job)) return {};
  return countFromRecord(job, run);
}

export function pendingPatches() {
  return outbox.slice();
}

export function acknowledgePatches(count) {
  outbox = outbox.slice(count);
  scheduleSave();
}

/** Writes still in the outbox are laid back over the hub's copy, since the hub has not seen them yet. */
export function replaceJobs(work) {
  const next = {
    cron: new Map((work.crons ?? []).map((job) => [job.id, job])),
    execution: new Map((work.executions ?? []).map((job) => [job.id, job])),
  };
  for (const entry of outbox) {
    const existing = next[entry.kind].get(entry.id);
    if (existing) next[entry.kind].set(entry.id, { ...existing, ...entry.patch });
  }
  const before = snapshot();
  records.cron = next.cron;
  records.execution = next.execution;
  const jobsChanged = snapshot() !== before;
  const settingsChanged = JSON.stringify(work.settings ?? {}) !== JSON.stringify(settings);
  settings = work.settings ?? {};
  if (jobsChanged || settingsChanged) scheduleSave();
  return { jobsChanged, settingsChanged };
}

function snapshot() {
  const sorted = (map) => [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify([sorted(records.cron), sorted(records.execution)]);
}

export async function loadJobCache() {
  try {
    const saved = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
    records.cron = new Map((saved.crons ?? []).map((job) => [job.id, job]));
    records.execution = new Map((saved.executions ?? []).map((job) => [job.id, job]));
    settings = saved.settings ?? {};
    outbox = Array.isArray(saved.outbox) ? saved.outbox : [];
    return true;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[node] could not read ${STATE_FILE}: ${err.message}`);
    return false;
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save().catch((err) => console.error(`[node] could not save ${STATE_FILE}: ${err.message}`));
  }, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

async function save() {
  await fsp.mkdir(NODE_HOME, { recursive: true });
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  const state = {
    crons: [...records.cron.values()],
    executions: [...records.execution.values()],
    settings,
    outbox,
  };
  await fsp.writeFile(tmp, `${JSON.stringify(state)}\n`, 'utf8');
  await fsp.rename(tmp, STATE_FILE);
}

export async function flushJobCache() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await save();
}
