import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type GitError = Error & { stderr?: string };

export type WorktreeCleanup = { cleaned: string } | { skipped: string };

export type WorktreeIncludeWrite = { written: string; text: string } | { skipped: string };

export const WORKTREE_INCLUDE_FILE = '.worktreeinclude';

/** Runs git in `dir` and returns its trimmed stdout; a failure throws with git's own message. */
async function git(dir: string, args: string[], timeout = 60_000): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, ...args], { timeout });
    return stdout.trim();
  } catch (err) {
    throw new Error((err as GitError).stderr?.trim() || (err as GitError).message, { cause: err });
  }
}

/**
 * The top of the git repository `dir` sits in, or null when it is not in one.
 *
 * Claude Code reads .worktreeinclude from the repository root whatever folder
 * the session starts in, so a job whose working directory is a subfolder still
 * has to write it at the top.
 */
export async function repoRoot(dir: string): Promise<string | null> {
  return (await git(dir, ['rev-parse', '--show-toplevel'], 10_000).catch(() => '')) || null;
}

/**
 * The main checkout of the repository `dir` belongs to: the folder holding the
 * shared `.git`. It differs from `repoRoot` when `dir` is inside a linked
 * worktree, and it is where Claude Code makes worktrees and reads
 * .worktreeinclude from.
 */
export async function mainCheckoutRoot(dir: string): Promise<string | null> {
  const commonDir = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 10_000).catch(() => '');
  if (!commonDir) return null;
  return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : repoRoot(dir);
}

/** Every worktree git knows of in the repository `dir` belongs to, with the branch each one has checked out. */
async function listWorktrees(dir: string): Promise<Array<{ path: string; branch: string | null }>> {
  const worktrees: Array<{ path: string; branch: string | null }> = [];
  for (const block of (await git(dir, ['worktree', 'list', '--porcelain'])).split('\n\n')) {
    const lines = block.split('\n');
    const worktreePath = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
    if (!worktreePath) continue;
    const branch = lines.find((line) => line.startsWith('branch '))?.slice('branch '.length) ?? null;
    worktrees.push({ path: worktreePath, branch });
  }
  return worktrees;
}

/**
 * Force-removes the worktree Claude Code makes for `--worktree <name>`, and
 * deletes its `worktree-<name>` branch. Uncommitted files in it are not kept.
 * The branch's last commit goes in the result, so work committed only there
 * can still be recovered from it.
 *
 * The worktree is found through git rather than by building its path: Claude
 * Code puts it under the main checkout's `.claude/worktrees`, which is not the
 * folder `dir` is in when the job runs inside a linked worktree.
 *
 * @returns {Promise<{ cleaned: string } | { skipped: string }>} What was removed,
 *   or why there was nothing to remove.
 */
export async function removeWorktree(dir: string, name: string): Promise<WorktreeCleanup> {
  const root = await repoRoot(dir);
  if (!root) return { skipped: `${dir} is not in a git repository` };
  const branch = `worktree-${name}`;
  const removed: string[] = [];

  const registered = (await listWorktrees(root)).find((worktree) => worktree.branch === `refs/heads/${branch}`)?.path;
  const fallback = path.join((await mainCheckoutRoot(root)) ?? root, '.claude', 'worktrees', name);
  const worktreePath = registered ?? ((await fsp.stat(fallback).then(() => true, () => false)) ? fallback : null);

  if (worktreePath) {
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
 * Where `dir` sits inside its repository, such as `apps/web`, or null at the
 * top of one or outside git. The root git reports has its symlinks resolved,
 * so `dir` is resolved too before the two are compared.
 */
export async function pathInRepo(dir: string): Promise<string | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const relative = path.relative(root, await fsp.realpath(dir).catch(() => dir));
  return relative && !relative.startsWith('..') ? relative : null;
}

/**
 * Writes the default .worktreeinclude to the main checkout of the repository
 * `dir` is in, replacing whatever file is there. Claude Code reads it from
 * there even when the job runs inside a linked worktree.
 *
 * Empty text writes nothing rather than blanking a file the repo may rely on,
 * and a folder outside git writes nothing because there is no worktree to make.
 *
 * @returns {Promise<{ written: string, text: string } | { skipped: string }>} The
 *   path written and the exact text now in the file, or why nothing was written.
 */
export async function writeWorktreeInclude(dir: string, text: string): Promise<WorktreeIncludeWrite> {
  if (!text.trim()) return { skipped: 'the default on the Settings page is empty' };
  const root = await mainCheckoutRoot(dir);
  if (!root) return { skipped: `${dir} is not in a git repository` };
  const target = path.join(root, WORKTREE_INCLUDE_FILE);
  const content = text.endsWith('\n') ? text : `${text}\n`;
  await fsp.writeFile(target, content, 'utf8');
  return { written: target, text: content };
}
