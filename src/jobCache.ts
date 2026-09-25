import fsp from 'node:fs/promises';
import path from 'node:path';
import { NODE_HOME, NODE_LOGS_DIR } from './paths.js';
import { safeName } from './store.js';
import { byScheduledAtDesc } from './executions.js';
import { countRun as countFromRecord, hasLifetimeStats } from './stats.js';
import type { RunOutcome } from './stats.js';
import type { Cron, Execution, JobKind, JobPatch, LifetimeStats, NodeSettings, NodeWork } from './types.js';

interface JobRecord {
  cron: Cron;
  execution: Execution;
}

type JobRecords = { [K in JobKind]: Map<string, JobRecord[K]> };

interface SavedState {
  crons?: Cron[];
  executions?: Execution[];
  settings?: Partial<NodeSettings>;
  outbox?: unknown;
}

/**
 * Stands in for the hub's store under the same names, so the cron service reads
 * and writes jobs exactly as it did when it owned the files. A write lands in
 * the copy at once and waits in the outbox until a report carries it to the hub.
 */

const STATE_FILE = path.join(NODE_HOME, 'state.json');
const SAVE_DELAY_MS = 500;

const records: JobRecords = { cron: new Map(), execution: new Map() };
let settings: Partial<NodeSettings> = {};
let outbox: JobPatch[] = [];
let saveTimer: NodeJS.Timeout | null = null;

function clone<T extends object>(value: T): T;
function clone<T extends object>(value: T | undefined): T | null;
function clone<T extends object>(value: T | undefined): T | null {
  return value ? structuredClone(value) : null;
}

export async function getCron(id: string): Promise<Cron | null> {
  return clone(records.cron.get(id));
}

export async function getExecution(id: string): Promise<Execution | null> {
  return clone(records.execution.get(id));
}

export async function listCrons(): Promise<Cron[]> {
  return [...records.cron.values()].map<Cron>(clone).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function listExecutions(): Promise<Execution[]> {
  return [...records.execution.values()].map<Execution>(clone).sort(byScheduledAtDesc);
}

function patch<K extends JobKind>(kind: K, id: string, fields: Partial<JobRecord[K]>): JobRecord[K] {
  const existing: JobRecord[K] | undefined = records[kind].get(id);
  const merged = { ...(existing ?? { id }), ...fields } as JobRecord[K];
  // A job the hub has since taken away still has its run recorded, but it is not
  // put back into the copy, where it would be armed again.
  if (existing) records[kind].set(id, merged);
  outbox.push({ kind, id, patch: fields as JobPatch['patch'] });
  scheduleSave();
  return clone(merged);
}

export async function patchCron(id: string, fields: Partial<Cron>): Promise<Cron> {
  return patch('cron', id, fields);
}

export async function patchExecution(id: string, fields: Partial<Execution>): Promise<Execution> {
  return patch('execution', id, fields);
}

export function jobSettings(): Partial<NodeSettings> {
  return settings;
}

export function logDir(jobId: string): string {
  return path.join(NODE_LOGS_DIR, safeName(jobId));
}

/**
 * The lifetime counters to add for a finished run. A record with no counters yet
 * is backfilled by the hub from the logs it holds, so the node adds nothing.
 */
export async function countRun(job: LifetimeStats & { id: string }, run: RunOutcome): Promise<LifetimeStats> {
  if (!hasLifetimeStats(job)) return {};
  return countFromRecord(job, run);
}

export function pendingPatches(): JobPatch[] {
  return outbox.slice();
}

export function acknowledgePatches(count: number): void {
  outbox = outbox.slice(count);
  scheduleSave();
}

/** Writes still in the outbox are laid back over the hub's copy, since the hub has not seen them yet. */
export function replaceJobs(work: Partial<Pick<NodeWork, 'crons' | 'executions' | 'settings'>>): {
  jobsChanged: boolean;
  settingsChanged: boolean;
} {
  const next: JobRecords = {
    cron: new Map((work.crons ?? []).map((job) => [job.id, job])),
    execution: new Map((work.executions ?? []).map((job) => [job.id, job])),
  };
  for (const entry of outbox) {
    const existing = next[entry.kind].get(entry.id);
    if (existing) (next[entry.kind] as Map<string, Cron | Execution>).set(entry.id, { ...existing, ...entry.patch } as Cron | Execution);
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

function snapshot(): string {
  const sorted = (map: Map<string, { id: string }>): Array<{ id: string }> => [...map.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify([sorted(records.cron), sorted(records.execution)]);
}

export async function loadJobCache(): Promise<boolean> {
  try {
    const saved = JSON.parse(await fsp.readFile(STATE_FILE, 'utf8')) as SavedState;
    records.cron = new Map((saved.crons ?? []).map((job) => [job.id, job]));
    records.execution = new Map((saved.executions ?? []).map((job) => [job.id, job]));
    settings = saved.settings ?? {};
    outbox = Array.isArray(saved.outbox) ? (saved.outbox as JobPatch[]) : [];
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[node] could not read ${STATE_FILE}: ${(err as Error).message}`);
    return false;
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save().catch((err) => console.error(`[node] could not save ${STATE_FILE}: ${(err as Error).message}`));
  }, SAVE_DELAY_MS);
  saveTimer.unref?.();
}

async function save(): Promise<void> {
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

export async function flushJobCache(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  await save();
}
