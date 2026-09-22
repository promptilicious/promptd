import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { CRONS_DIR, LOGS_DIR } from './paths.js';
import { normalizeUsageDelay } from './usage.js';

export const MAX_LOGS_PER_CRON = 50;

/** Filesystem-safe version of a user supplied name. */
export function safeName(name) {
  const cleaned = String(name)
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .slice(0, 120);
  return cleaned || 'unnamed';
}

function cronFile(id) {
  return path.join(CRONS_DIR, `${id}.json`);
}

export async function listCrons() {
  let names = [];
  try {
    names = await fs.readdir(CRONS_DIR);
  } catch {
    return [];
  }
  const crons = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const raw = await fs.readFile(path.join(CRONS_DIR, name), 'utf8');
      const cron = JSON.parse(raw);
      cron.id ||= name.replace(/\.json$/, '');
      crons.push(cron);
    } catch (err) {
      console.error(`[store] skipping unreadable cron ${name}: ${err.message}`);
    }
  }
  return crons.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export async function getCron(id) {
  try {
    return JSON.parse(await fs.readFile(cronFile(id), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Temp file then rename, so a crash never leaves half a JSON file behind. */
async function writeCron(cron) {
  const target = cronFile(cron.id);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(cron, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, target);
}

export async function createCron(input) {
  const now = new Date().toISOString();
  const cron = {
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
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
  };
  await writeCron(cron);
  return cron;
}

export async function updateCron(id, input) {
  const existing = await getCron(id);
  if (!existing) return null;
  const cron = {
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
    updatedAt: new Date().toISOString(),
  };
  // A rename moves no logs: the folder is the cron's id.
  await writeCron(cron);
  return cron;
}

/** Records the outcome of a run on the cron itself, so the home page can show "last ran". */
export async function patchCron(id, patch) {
  const existing = await getCron(id);
  if (!existing) return null;
  const cron = { ...existing, ...patch };
  await writeCron(cron);
  return cron;
}

export async function deleteCron(id) {
  try {
    await fs.unlink(cronFile(id));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

// ---- logs -------------------------------------------------------------

/**
 * Logs live under the cron's id, not its name: two crons may share a name, and
 * an id never moves. `safeName` still runs over it so a hand-edited id cannot
 * escape the logs folder. Folders written by older versions are renamed on boot
 * by migrateLogDirs.
 */
export function logDir(cronId) {
  return path.join(LOGS_DIR, safeName(cronId));
}

export function logPath(cronId, file) {
  const base = path.basename(file);
  if (base !== file || !/^[\w.:+-]+\.txt$/.test(base)) throw new Error('invalid log file name');
  return path.join(logDir(cronId), base);
}

/** Log file names sort lexicographically in start-time order. */
export function logFileName(startedAt) {
  return `${startedAt.toISOString().replace(/:/g, '-')}.txt`;
}

export function startedAtFromLogFile(file) {
  const stamp = file.replace(/\.txt$/, '');
  const iso = stamp.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3');
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Newest first. */
export async function listLogs(cronId) {
  let names = [];
  try {
    names = await fs.readdir(logDir(cronId));
  } catch {
    return [];
  }
  const logs = [];
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

export async function readLog(cronId, file) {
  return fs.readFile(logPath(cronId, file), 'utf8');
}

/** Keeps the newest MAX_LOGS_PER_CRON runs for one cron, deleting the rest. */
export async function pruneLogs(cronId, keep = MAX_LOGS_PER_CRON) {
  const logs = await listLogs(cronId);
  const stale = logs.slice(keep);
  for (const log of stale) {
    await fs.unlink(path.join(logDir(cronId), log.file)).catch(() => {});
  }
  return stale.length;
}
