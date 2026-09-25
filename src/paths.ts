import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

// Override with PROMPTD_HOME for testing or a non-default storage location.
export const ROOT = process.env.PROMPTD_HOME
  ? path.resolve(process.env.PROMPTD_HOME)
  : path.join(os.homedir(), '.claude', 'promptd');

// Both kinds write here, each under its own id: ids are unique across the two,
// so one folder serves both without a prefix.
export const LOGS_DIR = path.join(ROOT, 'logs');
// The secret a node presents to the hub. A node on the same machine reads it
// from here; one elsewhere is given it through PROMPTD_NODE_TOKEN.
export const NODE_TOKEN_FILE = path.join(ROOT, 'node-token');
// A node's own state: its copy of the jobs it runs, and the logs of runs still
// being uploaded to the hub.
export const NODE_HOME = process.env.PROMPTD_NODE_HOME ? path.resolve(process.env.PROMPTD_NODE_HOME) : path.join(ROOT, 'node');
export const NODE_LOGS_DIR = path.join(NODE_HOME, 'logs');

/**
 * Turns a leading `~` into the home directory and makes the path absolute.
 * Anything not starting with `/` or `~/` is treated as relative to home, not to
 * wherever the server happened to be started — that is what a user typing in the
 * Working Directory field means, and it keeps suggestions honest.
 */
export function resolveUserPath(input: unknown): string | null {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.resolve(path.join(os.homedir(), raw.slice(2)));
  if (path.isAbsolute(raw)) return path.resolve(raw);
  return path.resolve(path.join(os.homedir(), raw));
}

export async function ensureDirs(): Promise<void> {
  await fs.mkdir(LOGS_DIR, { recursive: true });
}
