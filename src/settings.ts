import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import { ROOT } from './paths.js';
import type { Settings } from './types.js';
import { DEFAULT_USAGE_THRESHOLDS, normalizeUsageThresholds } from './usage.js';

export const LEGACY_SETTINGS_FILE = path.join(ROOT, 'settings.json');

/**
 * How many runs may be in flight at once, out of the box.
 *
 * Every run is a `claude` process of its own, so the processor count is the
 * point past which they stop getting more done and start competing for the
 * same cores. Setting it to 0 turns the limit off entirely.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS = os.cpus().length || 1;

/** A whole number of jobs, or null when the input is not one. 0 is unlimited. */
export function normalizeMaxConcurrentJobs(input: unknown): number | null {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export const DEFAULT_SETTINGS: Settings = {
  // Shown after "promptd" in the header bar. Blank shows the name alone.
  serverName: '',
  // The accent and the band across the header bar, as #rrggbb. Blank is the default orange.
  serverColor: '',
  // Check once a day whether the project's main branch is behind its remote,
  // and if so pull and restart. Set false to leave updates to you.
  selfUpdate: true,
  updateCheckIntervalHours: 24,
  // Filled in by the checker so "once a day" survives a restart.
  lastUpdateCheckAt: null,
  lastUpdateLaunchedAt: null,
  lastUpdateFromCommit: null,
  // Runs allowed at once. A trigger arriving with every slot taken is held as
  // delayed and started, oldest first, as the running ones finish. 0 is no limit.
  maxConcurrentJobs: DEFAULT_MAX_CONCURRENT_JOBS,
  // The percentage each Delay for usage limit has to reach before a cron that
  // ticks it is held.
  usageDelayThresholds: DEFAULT_USAGE_THRESHOLDS,
  // Where the Working Directory field of a new cron or one-time execution starts.
  defaultWorkingDirectory: '~/',
  // Where the Prompt field of a new cron or one-time execution starts.
  defaultPrompt: '',
  // One per line; each is a button under the Prompt field of the job forms that
  // copies it to the clipboard.
  commonCommands: '',
  // Written as .worktreeinclude to the root of a job's git repository when it runs
  // in a worktree, naming the ignored files Claude Code copies into new ones.
  defaultWorktreeInclude: '',
  // Set once the log folders have been renamed from cron names to cron ids.
  logsMigrated: false,
  // The node that runs a job with no node of its own. Set to the first node that connects.
  defaultNodeId: '',
  localNodeAgentCheckedAt: null,
};

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Reads settings, writing the defaults the first time. Unknown keys are kept. */
export async function loadSettings(): Promise<Settings> {
  const rows = await db().selectFrom('settings').selectAll().execute();
  if (!rows.length) {
    await saveSettings(DEFAULT_SETTINGS);
    console.log('[settings] wrote defaults');
    return { ...DEFAULT_SETTINGS };
  }
  const stored: Partial<Settings> = Object.fromEntries(rows.map((row) => [row.key, parseValue(row.value)]));
  // Filled per key, so a stored value that drops one threshold keeps the other three.
  return { ...DEFAULT_SETTINGS, ...stored, usageDelayThresholds: normalizeUsageThresholds(stored.usageDelayThresholds) };
}

async function writeKeys(values: Partial<Settings>): Promise<void> {
  const rows = Object.entries(values).map(([key, value]) => ({ key, value: JSON.stringify(value ?? null) }));
  if (!rows.length) return;
  await db()
    .insertInto('settings')
    .values(rows)
    .onConflict((conflict) => conflict.column('key').doUpdateSet((eb) => ({ value: eb.ref('excluded.value') })))
    .execute();
}

export async function saveSettings(settings: Settings): Promise<Settings> {
  await writeKeys(settings);
  return settings;
}

/** Writes only the keys given, so two saves of different settings cannot undo each other. */
export async function patchSettings(patch: Partial<Settings>): Promise<Settings> {
  await writeKeys(patch);
  return loadSettings();
}
