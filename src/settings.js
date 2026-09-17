import fsp from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './paths.js';

export const SETTINGS_FILE = path.join(ROOT, 'settings.json');

export const DEFAULT_SETTINGS = {
  // Check once a day whether the project's main branch is behind its remote,
  // and if so pull and restart. Set false to leave updates to you.
  selfUpdate: true,
  updateCheckIntervalHours: 24,
  // Filled in by the checker so "once a day" survives a restart.
  lastUpdateCheckAt: null,
  lastUpdateLaunchedAt: null,
  lastUpdateFromCommit: null,
  // Set once the log folders have been renamed from cron names to cron ids.
  logsMigrated: false,
};

/** Reads settings, writing the defaults file the first time. Unknown keys are kept. */
export async function loadSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...parsed };
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
