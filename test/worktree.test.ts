import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { removeWorktree, writeWorktreeInclude } from '../src/worktree.js';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function branchExists(repo: string, branch: string): boolean {
  return Boolean(git(repo, 'branch', '--list', branch));
}

/** What `claude --worktree <name>` leaves behind: a locked worktree under the main repository. */
function claudeWorktree(mainRepo: string, name: string): string {
  const worktree = path.join(mainRepo, '.claude', 'worktrees', name);
  git(mainRepo, 'worktree', 'add', '-q', '-b', `worktree-${name}`, worktree);
  git(mainRepo, 'worktree', 'lock', '--reason', `claude session ${name} (pid 1)`, worktree);
  return worktree;
}

let mainRepo: string;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-worktree-'));
  mainRepo = path.join(base, 'platform');
  fs.mkdirSync(mainRepo);
  git(mainRepo, 'init', '-q', '-b', 'main');
  git(mainRepo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
});

describe('removeWorktree', () => {
  it('removes the worktree and its branch for a job in the main checkout', async () => {
    const worktree = claudeWorktree(mainRepo, 'job-1');
    const result = await removeWorktree(mainRepo, 'job-1');
    expect(result).toHaveProperty('cleaned');
    expect(fs.existsSync(worktree)).toBe(false);
    expect(branchExists(mainRepo, 'worktree-job-1')).toBe(false);
  });

  it('finds the worktree under the main repository for a job in a linked worktree', async () => {
    const linked = path.join(path.dirname(mainRepo), 'platform-ci-patrol');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'ci-patrol', linked);
    const worktree = claudeWorktree(mainRepo, 'job-2');

    const result = await removeWorktree(linked, 'job-2');
    expect(result).toHaveProperty('cleaned');
    expect(fs.existsSync(worktree)).toBe(false);
    expect(branchExists(mainRepo, 'worktree-job-2')).toBe(false);
    expect(fs.existsSync(linked)).toBe(true);
  });

  it('works from a subfolder of the checkout', async () => {
    const sub = path.join(mainRepo, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    const worktree = claudeWorktree(mainRepo, 'job-3');
    await removeWorktree(sub, 'job-3');
    expect(fs.existsSync(worktree)).toBe(false);
  });

  it('says there was nothing to remove when the job never made a worktree', async () => {
    expect(await removeWorktree(mainRepo, 'never-ran')).toEqual({ skipped: expect.stringContaining('no worktree named never-ran') });
  });

  it('leaves a worktree belonging to another job alone', async () => {
    const other = claudeWorktree(mainRepo, 'other-job');
    await removeWorktree(mainRepo, 'job-4');
    expect(fs.existsSync(other)).toBe(true);
    expect(branchExists(mainRepo, 'worktree-other-job')).toBe(true);
  });
});

describe('writeWorktreeInclude', () => {
  it('writes to the main checkout for a job in a linked worktree, where Claude Code reads it', async () => {
    const linked = path.join(path.dirname(mainRepo), 'platform-ci-patrol');
    git(mainRepo, 'worktree', 'add', '-q', '-b', 'ci-patrol', linked);
    const result = await writeWorktreeInclude(linked, '.env');
    expect(result).toMatchObject({ written: path.join(fs.realpathSync(mainRepo), '.worktreeinclude') });
    expect(fs.readFileSync(path.join(mainRepo, '.worktreeinclude'), 'utf8')).toBe('.env\n');
    expect(fs.existsSync(path.join(linked, '.worktreeinclude'))).toBe(false);
  });

  it('writes to the checkout root for a job in a subfolder', async () => {
    const sub = path.join(mainRepo, 'apps', 'web');
    fs.mkdirSync(sub, { recursive: true });
    await writeWorktreeInclude(sub, '.env.local');
    expect(fs.readFileSync(path.join(mainRepo, '.worktreeinclude'), 'utf8')).toBe('.env.local\n');
  });
});
