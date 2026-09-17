import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Override with CONDUCTOR_HOME for testing or a non-default storage location.
export const ROOT = process.env.CONDUCTOR_HOME
  ? path.resolve(process.env.CONDUCTOR_HOME)
  : path.join(os.homedir(), '.claude', 'claude-conductor');

// One folder per model.
export const CRONS_DIR = path.join(ROOT, 'crons');
// One-time executions are kept apart from the crons so the cron folder watcher
// has less to poll, and so a folder listing stays readable once there are
// hundreds of one-off runs behind you.
export const EXECUTIONS_DIR = path.join(ROOT, 'executions');
// Both kinds write here, each under its own id: ids are unique across the two,
// so one folder serves both without a prefix.
export const LOGS_DIR = path.join(ROOT, 'logs');

/**
 * Turns a leading `~` into the home directory and makes the path absolute.
 * Anything not starting with `/` or `~/` is treated as relative to home, not to
 * wherever the server happened to be started — that is what a user typing in the
 * Working Directory field means, and it keeps suggestions honest.
 */
export function resolveUserPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.resolve(path.join(os.homedir(), raw.slice(2)));
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(path.join(os.homedir(), raw));
}

export async function ensureDirs() {
  await fs.mkdir(CRONS_DIR, { recursive: true });
  await fs.mkdir(EXECUTIONS_DIR, { recursive: true });
  await fs.mkdir(LOGS_DIR, { recursive: true });
}
