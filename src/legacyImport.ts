import fsp from 'node:fs/promises';
import path from 'node:path';

import { db } from './db.js';
import type { NodeTable, NotificationTable } from './db.js';
import { cronToRow, executionToRow } from './jobRows.js';
import { ROOT } from './paths.js';
import { LEGACY_SETTINGS_FILE, loadSettings, patchSettings } from './settings.js';
import type { Cron, Execution, Settings } from './types.js';
import { normalizeUsageDelay } from './usage.js';

export const LEGACY_CRONS_DIR = path.join(ROOT, 'crons');
export const LEGACY_EXECUTIONS_DIR = path.join(ROOT, 'executions');
const LEGACY_NOTIFICATIONS_DIR = path.join(ROOT, 'notifications');
const LEGACY_NODES_FILE = path.join(ROOT, 'nodes.json');
const IMPORTED_KEY = 'importedFromFilesAt';

export interface ImportSummary {
  crons: number;
  executions: number;
  notifications: number;
  nodes: number;
  settings: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error(`[import] skipping unreadable ${file}: ${(err as Error).message}`);
    return null;
  }
}

async function readFolder(dir: string): Promise<Array<{ id: string; record: Record<string, unknown> }>> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const found: Array<{ id: string; record: Record<string, unknown> }> = [];
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const record = await readJson(path.join(dir, name));
    if (isRecord(record)) found.push({ id: String(record.id ?? name.replace(/\.json$/, '')), record });
  }
  return found;
}

function jobDefaults(id: string, record: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    description: '',
    workingDirectory: '',
    useWorktree: false,
    cleanupWorktree: false,
    model: '',
    effort: '',
    prompt: '',
    isActive: false,
    nodeId: '',
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
    ...record,
    id,
    name: String(record.name ?? id),
    usageDelay: normalizeUsageDelay(record.usageDelay),
  };
}

async function importCrons(): Promise<number> {
  let count = 0;
  for (const { id, record } of await readFolder(LEGACY_CRONS_DIR)) {
    const cron = { ...jobDefaults(id, record), cron: String(record.cron ?? '') } as Cron;
    const result = await db().insertInto('crons').values(cronToRow(cron)).onConflict((conflict) => conflict.doNothing()).executeTakeFirst();
    count += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return count;
}

async function importExecutions(): Promise<number> {
  let count = 0;
  for (const { id, record } of await readFolder(LEGACY_EXECUTIONS_DIR)) {
    const execution = {
      status: 'done',
      scheduledAt: null,
      firedAt: null,
      stoppedBy: null,
      ...jobDefaults(id, record),
      cleanupWorktree: true,
    } as Execution;
    const result = await db()
      .insertInto('executions')
      .values(executionToRow(execution))
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();
    count += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return count;
}

async function importNotifications(): Promise<number> {
  const rows: NotificationTable[] = [];
  for (const { id, record } of await readFolder(LEGACY_NOTIFICATIONS_DIR)) {
    if (typeof record.at !== 'string') continue;
    rows.push({
      id,
      at: record.at,
      kind: String(record.kind ?? 'info'),
      message: String(record.message ?? ''),
      read: record.read ? 1 : 0,
      cronId: typeof record.cronId === 'string' ? record.cronId : null,
      cronName: typeof record.cronName === 'string' ? record.cronName : null,
      jobKind: record.jobKind === 'execution' ? 'execution' : 'cron',
    });
  }
  let count = 0;
  for (let index = 0; index < rows.length; index += 200) {
    const result = await db()
      .insertInto('notifications')
      .values(rows.slice(index, index + 200))
      .onConflict((conflict) => conflict.doNothing())
      .executeTakeFirst();
    count += Number(result.numInsertedOrUpdatedRows ?? 0);
  }
  return count;
}

async function importNodes(): Promise<number> {
  const saved = await readJson(LEGACY_NODES_FILE);
  if (!Array.isArray(saved)) return 0;
  const now = new Date().toISOString();
  const rows: NodeTable[] = saved.filter(isRecord).map((node) => ({
    id: String(node.id),
    name: String(node.name ?? node.id),
    hostname: typeof node.hostname === 'string' ? node.hostname : null,
    platform: typeof node.platform === 'string' ? node.platform : null,
    commit: typeof node.commit === 'string' ? node.commit : null,
    firstSeenAt: typeof node.firstSeenAt === 'string' ? node.firstSeenAt : now,
    lastSeenAt: typeof node.lastSeenAt === 'string' ? node.lastSeenAt : now,
  }));
  if (!rows.length) return 0;
  const result = await db().insertInto('nodes').values(rows).onConflict((conflict) => conflict.doNothing()).executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0);
}

/**
 * Copies an install from before the database into it, once. The files are left
 * where they are, so going back to an older version still finds them.
 */
export async function importLegacyFiles(): Promise<ImportSummary | null> {
  const marker = await db().selectFrom('settings').select('value').where('key', '=', IMPORTED_KEY).executeTakeFirst();
  if (marker) return null;

  const legacySettings = await readJson(LEGACY_SETTINGS_FILE);
  const hadSettings = isRecord(legacySettings);
  if (hadSettings) await patchSettings(legacySettings as Partial<Settings>);
  const summary: ImportSummary = {
    crons: await importCrons(),
    executions: await importExecutions(),
    notifications: await importNotifications(),
    nodes: await importNodes(),
    settings: hadSettings,
  };
  await loadSettings();
  await db()
    .insertInto('settings')
    .values({ key: IMPORTED_KEY, value: JSON.stringify(new Date().toISOString()) })
    .onConflict((conflict) => conflict.doNothing())
    .execute();
  if (summary.crons || summary.executions || summary.notifications || summary.nodes || summary.settings) {
    console.log(
      `[import] copied ${summary.crons} cron(s), ${summary.executions} one-time execution(s), ${summary.notifications} notification(s), ${summary.nodes} node(s)${summary.settings ? ' and settings.json' : ''} into the database`,
    );
  }
  return summary;
}
