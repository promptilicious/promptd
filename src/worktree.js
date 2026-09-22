import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/**
 * The top of the git repository `dir` sits in, or null when it is not in one.
 *
 * Claude Code reads .worktreeinclude from the repository root whatever folder
 * the session starts in, so a job whose working directory is a subfolder still
 * has to write it at the top.
 */
export async function repoRoot(dir) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { timeout: 10_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Writes the default .worktreeinclude to the root of the repository `dir` is
 * in, replacing whatever file is there.
 *
 * Empty text writes nothing rather than blanking a file the repo may rely on,
 * and a folder outside git writes nothing because there is no worktree to make.
 *
 * @returns {Promise<{ written: string, text: string } | { skipped: string }>} The
 *   path written and the exact text now in the file, or why nothing was written.
 */
export async function writeWorktreeInclude(dir, text) {
  if (!text.trim()) return { skipped: 'the default on the Settings page is empty' };
  const root = await repoRoot(dir);
  if (!root) return { skipped: `${dir} is not in a git repository` };
  const target = path.join(root, WORKTREE_INCLUDE_FILE);
  const content = text.endsWith('\n') ? text : `${text}\n`;
  await fsp.writeFile(target, content, 'utf8');
  return { written: target, text: content };
}
