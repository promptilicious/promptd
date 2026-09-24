import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './paths.js';
import { DEFAULT_USAGE_THRESHOLDS, normalizeUsageThresholds } from './usage.js';

export const SETTINGS_FILE = path.join(ROOT, 'settings.json');

/**
 * How many runs may be in flight at once, out of the box.
 *
 * Every run is a `claude` process of its own, so the processor count is the
 * point past which they stop getting more done and start competing for the
 * same cores. Setting it to 0 turns the limit off entirely.
 */
export const DEFAULT_MAX_CONCURRENT_JOBS = os.cpus().length || 1;

/** A whole number of jobs, or null when the input is not one. 0 is unlimited. */
export function normalizeMaxConcurrentJobs(input) {
  const value = Number(input);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export const DEFAULT_SETTINGS = {
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
};

/** Reads settings, writing the defaults file the first time. Unknown keys are kept. */
export async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
    // Filled per key, so a hand edit that drops one threshold keeps the other three.
    return { ...DEFAULT_SETTINGS, ...parsed, usageDelayThresholds: normalizeUsageThresholds(parsed?.usageDelayThresholds) };
  } catch (err) {
    if (err.code === 'ENOENT') {
      await saveSettings(DEFAULT_SETTINGS);
      console.log(`[settings] wrote defaults to ${SETTINGS_FILE}`);
      return { ...DEFAULT_SETTINGS };
    }
    // A broken file is left alone rather than overwritten — it may be a bad hand edit.
    console.error(`[settings] ${SETTINGS_FILE} is unreadable (${err.message}); using defaults`);
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings) {
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await fsp.rename(tmp, SETTINGS_FILE);
  return settings;
}

export async function patchSettings(patch) {
  return saveSettings({ ...(await loadSettings()), ...patch });
}
