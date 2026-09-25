import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
import { cronToRow, rowToCron } from './jobRows.js';
import { LOGS_DIR } from './paths.js';
import { normalizeUsageDelay } from './usage.js';
import type { Cron, CronInput } from './types.js';

export interface LogFile {
  file: string;
  startedAt: string | null;
  size: number;
  modifiedAt: string;
}

export const MAX_LOGS_PER_CRON = 50;

/** Filesystem-safe version of a user supplied name. */
export function safeName(name: unknown): string {
  const cleaned = String(name)
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'unnamed';
}

export async function listCrons(): Promise<Cron[]> {
  const rows = await db().selectFrom('crons').selectAll().orderBy('name').execute();
  return rows.map(rowToCron).sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getCron(id: string): Promise<Cron | null> {
  const row = await db().selectFrom('crons').selectAll().where('id', '=', id).executeTakeFirst();
  return row ? rowToCron(row) : null;
}

export async function insertCron(cron: Cron): Promise<void> {
  await db().insertInto('crons').values(cronToRow(cron)).execute();
}

async function writeCron(cron: Cron): Promise<void> {
  const { id, ...columns } = cronToRow(cron);
  await db().updateTable('crons').set(columns).where('id', '=', id).execute();
}

export async function createCron(input: CronInput): Promise<Cron> {
  const now = new Date().toISOString();
  const cron: Cron = {
    id: randomUUID(),
    name: input.name,
    description: input.description ?? '',
    cron: input.cron,
    workingDirectory: input.workingDirectory ?? '',
    useWorktree: Boolean(input.useWorktree),
    cleanupWorktree: Boolean(input.cleanupWorktree),
    model: input.model ?? '',
    effort: input.effort ?? '',
    usageDelay: normalizeUsageDelay(input.usageDelay),
    prompt: input.prompt ?? '',
    isActive: Boolean(input.isActive),
    nodeId: input.nodeId ?? '',
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
  await insertCron(cron);
  return cron;
}

export async function updateCron(id: string, input: CronInput): Promise<Cron | null> {
  const existing = await getCron(id);
  if (!existing) return null;
  const cron: Cron = {
    ...existing,
    name: input.name,
    description: input.description ?? '',
    cron: input.cron,
    workingDirectory: input.workingDirectory ?? '',
    useWorktree: Boolean(input.useWorktree),
    cleanupWorktree: Boolean(input.cleanupWorktree),
    model: input.model ?? '',
    effort: input.effort ?? '',
    usageDelay: normalizeUsageDelay(input.usageDelay),
    prompt: input.prompt ?? '',
    isActive: Boolean(input.isActive),
    nodeId: input.nodeId ?? '',
    updatedAt: new Date().toISOString(),
  };
  // A rename moves no logs: the folder is the cron's id.
  await writeCron(cron);
  return cron;
}

/** Records the outcome of a run on the cron itself, so the home page can show "last ran". */
export async function patchCron(id: string, patch: Partial<Cron>): Promise<Cron | null> {
  const existing = await getCron(id);
  if (!existing) return null;
  const cron: Cron = { ...existing, ...patch };
  await writeCron(cron);
  return cron;
}

export async function deleteCron(id: string): Promise<boolean> {
  const result = await db().deleteFrom('crons').where('id', '=', id).executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}

// ---- logs -------------------------------------------------------------

/**
 * Logs live under the cron's id, not its name: two crons may share a name, and
 * an id never moves. `safeName` still runs over it so a hand-edited id cannot
 * escape the logs folder. Folders written by older versions are renamed on boot
 * by migrateLogDirs.
 */
export function logDir(cronId: string): string {
  return path.join(LOGS_DIR, safeName(cronId));
}

export function logPath(cronId: string, file: string): string {
  const base = path.basename(file);
  if (base !== file || !/^[\w.:+-]+\.txt$/.test(base)) throw new Error('invalid log file name');
  return path.join(logDir(cronId), base);
}

/** Log file names sort lexicographically in start-time order. */
export function logFileName(startedAt: Date): string {
  return `${startedAt.toISOString().replace(/:/g, '-')}.txt`;
}

export function startedAtFromLogFile(file: string): string | null {
  const stamp = file.replace(/\.txt$/, '');
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Newest first. */
export async function listLogs(cronId: string): Promise<LogFile[]> {
  let names: string[];
  try {
    names = await fs.readdir(logDir(cronId));
  } catch {
    return [];
  }
  const logs: LogFile[] = [];
  for (const name of names.filter((n) => n.endsWith('.txt'))) {
    const stat = await fs.stat(path.join(logDir(cronId), name)).catch(() => null);
    if (!stat) continue;
    logs.push({
      file: name,
      startedAt: startedAtFromLogFile(name),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  }
  return logs.sort((a, b) => b.file.localeCompare(a.file));
}

export async function readLog(cronId: string, file: string): Promise<string> {
  return fs.readFile(logPath(cronId, file), 'utf8');
}

/** Keeps the newest MAX_LOGS_PER_CRON runs for one cron, deleting the rest. */
export async function pruneLogs(cronId: string, keep = MAX_LOGS_PER_CRON): Promise<number> {
  const logs = await listLogs(cronId);
  const stale = logs.slice(keep);
  for (const log of stale) {
    await fs.unlink(path.join(logDir(cronId), log.file)).catch(() => {});
  }
  return stale.length;
}
