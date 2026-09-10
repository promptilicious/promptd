import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emit } from './events.js';
import { LOGS_DIR } from './paths.js';
import { loadSettings, patchSettings } from './settings.js';
import { cronService } from './cronService.js';

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

// Restarting on top of a live run kills it: the run's stdout is a pipe to this
// process, so the child dies of EPIPE at its next write, mid-task and with
// nothing recorded. So an update holds the schedules and waits for the last run
// to end before the restart.
const DRAIN_INTERVAL_MS = 10 * 1000;
// A run that never ends must not hold the schedules paused forever. Generous,
// because a legitimately long cron finishing is worth more than a prompt update.
const DRAIN_LIMIT_MS = 4 * 60 * 60 * 1000;
// How long the restart gets to arrive after the script exits, before the pause
// is treated as stuck and lifted.
const RESTART_GRACE_MS = 5000;

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

/** The commit the project is checked out at, or null outside a repository. */
export async function currentCommit() {
  const head = await git(['rev-parse', '--short', 'HEAD'], 10000);
  return head.ok && head.out ? head.out : null;
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
    /** Set from the moment schedules are held until the restart takes us down. */
    this.draining = false;
    this.drainTimer = null;
    this.drainStartedAt = null;
    /**
     * The last answer to "is main behind?", whoever asked. Checking happens on
     * the interval whether or not selfUpdate is on, so the header badge can
     * offer an update the server has been told not to apply on its own.
     */
    this.lastCheck = { updatable: false, behind: 0, head: null, reason: null, at: null };
  }

  /** What the health endpoint and the header badge read. */
  availability() {
    return {
      updateAvailable: Boolean(this.lastCheck.updatable),
      updateBehind: this.lastCheck.behind,
      updateCheckedAt: this.lastCheck.at,
    };
  }

  /** Remembers a check result, announcing only a change of answer. */
  recordCheck(result) {
    const was = Boolean(this.lastCheck.updatable);
    this.lastCheck = {
      updatable: Boolean(result?.updatable),
      behind: Number(result?.behind) || 0,
      head: result?.head ?? null,
      reason: result?.reason ?? null,
      at: new Date().toISOString(),
    };
    if (was !== this.lastCheck.updatable) emit('update:availability', this.availability());
    return result;
  }

  /** What the page polls while an update is queued behind a running cron. */
  state() {
    return {
      draining: this.draining,
      runningCount: cronService.runningCount(),
      since: this.drainStartedAt ? new Date(this.drainStartedAt).toISOString() : null,
    };
  }

  start() {
    // Idempotent: calling it twice must not leave two intervals ticking.
    if (this.timer) return;
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
    if (this.draining) {
      // Already committed to updating; a second press just reports the wait.
      return { updatable: true, launched: true, waiting: true, pid: null, ...this.state() };
    }
    const result = this.recordCheck(await checkForUpdates());
    if (!result.updatable) {
      console.log(`[update] no update applied: ${result.reason}`);
      return { ...result, launched: false };
    }
    console.log(`[update] ${result.behind} commit(s) behind ${REMOTE}/${BRANCH}; holding schedules for the restart`);
    await patchSettings({ lastUpdateLaunchedAt: new Date().toISOString(), lastUpdateFromCommit: result.head });

    // Nothing new may start between here and the restart, and this pause cannot
    // be cancelled from the page.
    this.draining = true;
    this.drainStartedAt = Date.now();
    await cronService.pauseAll({ mode: 'update', label: 'for update' });
    emit('update:launched', { behind: result.behind, from: result.head, pid: null, ...this.state() });

    const pid = this.startDrain();
    return { ...result, launched: true, waiting: pid === null, pid, ...this.state() };
  }

  /**
   * Polls until no run is in flight, then hands over to the update script.
   * Returns the script's pid when it could start immediately, else null.
   */
  startDrain() {
    let pid = null;
    const tick = () => {
      const running = cronService.runningCount();
      if (running === 0) {
        this.stopDrain();
        pid = this.launch();
        return;
      }
      if (Date.now() - this.drainStartedAt >= DRAIN_LIMIT_MS) {
        console.error(`[update] gave up after ${Math.round(DRAIN_LIMIT_MS / 60000)}m; ${running} run(s) still going. Resuming schedules, update not applied.`);
        this.stopDrain();
        emit('update:abandoned', { runningCount: running });
        cronService.resumeAll('update gave up waiting').catch((err) => console.error(`[cron] resume failed: ${err.message}`));
        return;
      }
      console.log(`[update] waiting for ${running} run(s) to finish before restarting`);
      emit('update:waiting', { ...this.state(), runningCount: running });
    };

    this.drainTimer = setInterval(tick, DRAIN_INTERVAL_MS);
    this.drainTimer.unref?.();
    tick(); // check straight away rather than waiting out the first interval
    return pid;
  }

  stopDrain() {
    if (this.drainTimer) clearInterval(this.drainTimer);
    this.drainTimer = null;
    this.draining = false;
  }

  /**
   * The interval always checks; `selfUpdate` decides only whether a pending
   * update is applied. With it off the answer is kept for the header badge, so
   * an update can be offered without ever being taken.
   */
  async tick(force = false) {
    if (this.busy || this.draining) return null;
    const settings = await loadSettings();
    if (!force && !this.due(settings)) return null;

    this.busy = true;
    try {
      const result = settings.selfUpdate
        ? await this.applyIfBehind()
        : this.reportOnly(this.recordCheck(await checkForUpdates()));
      // Only the scheduled check moves the daily clock; pressing the button does not.
      await patchSettings({ lastUpdateCheckAt: new Date().toISOString() });
      return result;
    } finally {
      this.busy = false;
    }
  }

  reportOnly(result) {
    console.log(
      result.updatable
        ? `[update] ${result.behind} commit(s) behind ${REMOTE}/${BRANCH}; self update is off, so nothing was applied`
        : `[update] no update available: ${result.reason}`,
    );
    return { ...result, launched: false, reason: result.updatable ? 'self update is off' : result.reason };
  }

  /**
   * Hands the update to a process that outlives this one: it has to survive the
   * server being restarted, which is the last thing it does.
   */
  launch() {
    console.log('[update] no runs in flight; starting the update script');
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
    // A successful update restarts us, so the restart kills this process before
    // the grace period below runs out. Still being here after it means no restart
    // is coming — the script refused, found nothing to do, or had no launchd
    // agent to kick — so lift the pause rather than hold the crons forever.
    child.on('exit', (code) => {
      console.log(`[update] update script exited ${code}; waiting ${RESTART_GRACE_MS / 1000}s for the restart`);
      const grace = setTimeout(() => {
        console.error(`[update] no restart arrived; see ${UPDATE_LOG}. Resuming schedules.`);
        emit('update:failed', { code, updateLog: UPDATE_LOG });
        cronService.resumeAll('update finished without restarting').catch((err) => console.error(`[cron] resume failed: ${err.message}`));
      }, RESTART_GRACE_MS);
      grace.unref?.();
    });
    child.unref();
    fs.closeSync(logFd);
    console.log(`[update] updater started (pid ${child.pid}); progress in ${UPDATE_LOG}`);
    return child.pid;
  }
}

export const selfUpdater = new SelfUpdater();
