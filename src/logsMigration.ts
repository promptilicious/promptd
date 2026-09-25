import type { Dirent } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { LOGS_DIR } from './paths.js';
import { listCrons, safeName } from './store.js';
import { loadSettings, patchSettings } from './settings.js';
import type { Cron } from './types.js';

export interface LogMove {
  from: string;
  to: string;
  cronName: string;
}

export interface LogMigrationPlan {
  moves: LogMove[];
  alreadyById: number;
  unmatched: string[];
  contested: Array<{ name: string; cronIds: string[] }>;
}

export interface LogMigrationResult {
  skipped: boolean;
  renamed: number;
  merged: number;
  failed: Array<LogMove & { error: string }>;
}

/**
 * Maps the log folders on disk to the crons that wrote them.
 *
 * Folders were named after the cron until now, so the match is on the same
 * `safeName` the old code used to build them. A folder already named for a cron
 * id needs nothing. A folder matching no cron is somebody's history from a cron
 * since deleted: it is reported and left alone, never removed.
 *
 * Two crons sharing a name shared a folder, so a name can point at more than one
 * cron. The oldest wins it, since it is the one whose runs are most likely in
 * there, and the collision is reported.
 */
export async function planLogMigration(): Promise<LogMigrationPlan> {
  const crons = await listCrons();
  const ids = new Set(crons.map((cron) => cron.id));

  const byName = new Map<string, Cron>();
  const contested = new Map<string, Cron[]>();
  const oldestFirst = [...crons].sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  for (const cron of oldestFirst) {
    const key = safeName(cron.name);
    if (byName.has(key)) contested.set(key, [...(contested.get(key) ?? [byName.get(key)!]), cron]);
    else byName.set(key, cron);
  }

  let entries: Dirent[];
  try {
    entries = await fsp.readdir(LOGS_DIR, { withFileTypes: true });
  } catch {
    return { moves: [], alreadyById: 0, unmatched: [], contested: [] };
  }

  const moves: LogMove[] = [];
  const unmatched: string[] = [];
  let alreadyById = 0;
  for (const entry of entries) {
    // update.log is a file that lives beside the folders; only folders move.
    if (!entry.isDirectory()) continue;
    if (ids.has(entry.name)) {
      alreadyById += 1;
      continue;
    }
    const cron = byName.get(entry.name);
    if (!cron) {
      unmatched.push(entry.name);
      continue;
    }
    moves.push({ from: entry.name, to: cron.id, cronName: cron.name });
  }

  return {
    moves,
    alreadyById,
    unmatched,
    contested: [...contested].map(([name, list]) => ({ name, cronIds: list.map((c) => c.id) })),
  };
}

/** Moves one folder, merging file by file when the destination already exists. */
async function moveLogDir(from: string, to: string): Promise<'merged' | 'renamed'> {
  const fromPath = path.join(LOGS_DIR, from);
  const toPath = path.join(LOGS_DIR, to);
  const destExists = await fsp
    .access(toPath)
    .then(() => true)
    .catch(() => false);
  if (!destExists) {
    await fsp.rename(fromPath, toPath);
    return 'renamed';
  }
  for (const name of await fsp.readdir(fromPath)) {
    const target = path.join(toPath, name);
    const clash = await fsp
      .access(target)
      .then(() => true)
      .catch(() => false);
    // Same run, two folders: the file already there is the same log, so keep it.
    if (clash) await fsp.unlink(path.join(fromPath, name)).catch(() => {});
    else await fsp.rename(path.join(fromPath, name), target);
  }
  await fsp.rmdir(fromPath).catch(() => {});
  return 'merged';
}

/**
 * Renames every legacy log folder to its cron's id, once.
 *
 * `logsMigrated` in settings.json records that it has run, so later boots skip
 * the scan. It is only set after a clean pass: if a folder cannot be moved the
 * flag stays off and the next boot tries again, which is what keeps a half
 * finished migration from being written off as done.
 */
export async function migrateLogDirs({ force = false }: { force?: boolean } = {}): Promise<LogMigrationResult> {
  const settings = await loadSettings();
  if (settings.logsMigrated && !force) return { skipped: true, renamed: 0, merged: 0, failed: [] };

  const plan = await planLogMigration();
  let renamed = 0;
  let merged = 0;
  const failed: LogMigrationResult['failed'] = [];
  for (const move of plan.moves) {
    try {
      const how = await moveLogDir(move.from, move.to);
      if (how === 'merged') merged += 1;
      else renamed += 1;
      console.log(`[logs] ${how} "${move.from}" -> ${move.to} ("${move.cronName}")`);
    } catch (err) {
      failed.push({ ...move, error: (err as Error).message });
      console.error(`[logs] could not move "${move.from}" -> ${move.to}: ${(err as Error).message}`);
    }
  }

  for (const clash of plan.contested) {
    console.warn(`[logs] "${clash.name}" is used by ${clash.cronIds.length} crons; its logs went to ${clash.cronIds[0]}`);
  }
  if (plan.unmatched.length) {
    console.log(`[logs] left alone (no matching cron): ${plan.unmatched.join(', ')}`);
  }

  if (failed.length) {
    console.error(`[logs] ${failed.length} folder(s) still to move; will retry on the next boot`);
    return { skipped: false, renamed, merged, failed };
  }

  await patchSettings({ logsMigrated: true });
  if (renamed || merged) console.log(`[logs] migration done: ${renamed} renamed, ${merged} merged`);
  return { skipped: false, renamed, merged, failed };
}
