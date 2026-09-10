import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emit } from './events.js';
import { LOGS_DIR } from './paths.js';
import { loadSettings, patchSettings } from './settings.js';

// Normally the checkout this file lives in; overridable so the update path can
// be exercised against a scratch repository.
export const PROJECT_DIR = process.env.CONDUCTOR_PROJECT_DIR
  ? path.resolve(process.env.CONDUCTOR_PROJECT_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Nested with the run logs rather than loose in the storage root.
export const UPDATE_LOG = path.join(LOGS_DIR, 'update.log');
const UPDATE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'self-update.sh');

// Re-evaluate this often; whether a check is actually due is decided by the
// recorded timestamp, so sleeping through a whole day does not skip a check.
const TICK_MS = 15 * 60 * 1000;
const FIRST_TICK_MS = 60 * 1000;

const BRANCH = 'main';
const REMOTE = 'origin';

/** git, never interactive: no credential prompts, no host key questions, no pager. */
function git(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', PROJECT_DIR, ...args],
      {
        timeout,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
          GIT_PAGER: 'cat',
        },
      },
      (err, stdout, stderr) => {
        resolve({ ok: !err, out: String(stdout).trim(), err: String(stderr).trim() || err?.message || '' });
      },
    );
  });
}

/**
 * Is the project's main branch behind its remote? Returns a reason instead of a
 * count whenever the question cannot be answered safely.
 */
export async function checkForUpdates() {
  const repo = await git(['rev-parse', '--is-inside-work-tree']);
  if (!repo.ok || repo.out !== 'true') return { updatable: false, reason: 'not a git repository' };

  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch.out !== BRANCH) {
    return { updatable: false, reason: `on branch ${branch.out || 'unknown'}, not ${BRANCH}` };
  }

  const dirty = await git(['status', '--porcelain']);
  if (dirty.out) {
    return { updatable: false, reason: `${dirty.out.split('\n').length} uncommitted change(s) in the working tree` };
  }

  const fetched = await git(['fetch', REMOTE, BRANCH]);
  if (!fetched.ok) return { updatable: false, reason: `git fetch failed: ${fetched.err.split('\n')[0]}` };

  const counts = await git(['rev-list', '--left-right', '--count', `${BRANCH}...${REMOTE}/${BRANCH}`]);
  if (!counts.ok) return { updatable: false, reason: `could not compare with ${REMOTE}/${BRANCH}` };
  const [ahead, behind] = counts.out.split(/\s+/).map(Number);

  const head = await git(['rev-parse', '--short', 'HEAD']);
  if (behind > 0 && ahead > 0) {
    return { updatable: false, reason: `diverged: ${ahead} ahead, ${behind} behind`, behind, ahead };
  }
  return { updatable: behind > 0, behind, ahead, head: head.out, reason: behind > 0 ? null : 'already up to date' };
}

class SelfUpdater {
  constructor() {
    this.timer = null;
    this.busy = false;
  }

  start() {
    // A moment after boot, then on a slow tick. Not awaited by startup.
    setTimeout(() => this.tick(), FIRST_TICK_MS).unref?.();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  due(settings) {
    if (!settings.lastUpdateCheckAt) return true;
    const hours = Number(settings.updateCheckIntervalHours) || 24;
    const elapsed = Date.now() - new Date(settings.lastUpdateCheckAt).getTime();
    return !Number.isFinite(elapsed) || elapsed >= hours * 3600 * 1000;
  }

  /**
   * Checks, and launches the updater when main is behind. Shared by the daily
   * tick and the Update now button, so both behave identically.
   */
  async applyIfBehind() {
    const result = await checkForUpdates();
    if (!result.updatable) {
      console.log(`[update] no update applied: ${result.reason}`);
      return { ...result, launched: false };
    }
    console.log(`[update] ${result.behind} commit(s) behind ${REMOTE}/${BRANCH}; launching updater`);
    await patchSettings({ lastUpdateLaunchedAt: new Date().toISOString(), lastUpdateFromCommit: result.head });
    const pid = this.launch();
    emit('update:launched', { behind: result.behind, from: result.head, pid });
    return { ...result, launched: true, pid };
  }

  async tick(force = false) {
    if (this.busy) return null;
    const settings = await loadSettings();
    if (!settings.selfUpdate) return null;
    if (!force && !this.due(settings)) return null;

    this.busy = true;
    try {
      const result = await this.applyIfBehind();
      // Only the scheduled check moves the daily clock; pressing the button does not.
      await patchSettings({ lastUpdateCheckAt: new Date().toISOString() });
      return result;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Hands the update to a process that outlives this one: it has to survive the
   * server being restarted, which is the last thing it does.
   */
  launch() {
    const logFd = fs.openSync(UPDATE_LOG, 'a');
    const child = spawn('/bin/bash', [UPDATE_SCRIPT], {
      cwd: PROJECT_DIR,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: {
        ...process.env,
        CONDUCTOR_PROJECT_DIR: PROJECT_DIR,
        CONDUCTOR_LAUNCHD_LABEL: process.env.CONDUCTOR_LAUNCHD_LABEL ?? 'local.claude-conductor',
      },
    });
    child.unref();
    fs.closeSync(logFd);
    console.log(`[update] updater started (pid ${child.pid}); progress in ${UPDATE_LOG}`);
    return child.pid;
  }
}

export const selfUpdater = new SelfUpdater();
