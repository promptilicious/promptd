import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Runs git in `dir` and returns its trimmed stdout; a failure throws with git's own message. */
async function git(dir, args, timeout = 60_000) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout });
    return stdout.trim();
  } catch (err) {
    throw new Error(err.stderr?.trim() || err.message);
  }
}

/**
 * The top of the git repository `dir` sits in, or null when it is not in one.
 *
 * Claude Code reads .worktreeinclude from the repository root whatever folder
 * the session starts in, so a job whose working directory is a subfolder still
 * has to write it at the top.
 */
export async function repoRoot(dir) {
  return (await git(dir, ['rev-parse', '--show-toplevel'], 10_000).catch(() => '')) || null;
}

/**
 * Force-removes the worktree Claude Code makes for `--worktree <name>`, at
 * `.claude/worktrees/<name>` in the repository `dir` is in, and deletes its
 * `worktree-<name>` branch. Uncommitted files in it are not kept. The branch's
 * last commit goes in the result, so work committed only there can still be
 * recovered from it.
 *
 * @returns {Promise<{ cleaned: string } | { skipped: string }>} What was removed,
 *   or why there was nothing to remove.
 */
export async function removeWorktree(dir, name) {
  const root = await repoRoot(dir);
  if (!root) return { skipped: `${dir} is not in a git repository` };
  const worktreePath = path.join(root, '.claude', 'worktrees', name);
  const branch = `worktree-${name}`;
  const removed = [];

  if (await fsp.stat(worktreePath).then(() => true, () => false)) {
    // Claude Code locks the worktrees it makes, and git refuses to remove a locked one.
    await git(root, ['worktree', 'unlock', worktreePath]).catch(() => {});
    // node_modules can hold hundreds of thousands of files, so this can take a while.
    await git(root, ['worktree', 'remove', '--force', worktreePath], 10 * 60_000);
    removed.push(`removed ${worktreePath}`);
  }

  const tip = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).catch(() => '');
  if (tip) {
    await git(root, ['branch', '-D', branch]);
    removed.push(`deleted branch ${branch} (was ${tip.slice(0, 10)})`);
  }

  if (!removed.length) return { skipped: `no worktree named ${name} in ${root}` };
  return { cleaned: removed.join(', ') };
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
