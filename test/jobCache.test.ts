import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type * as JobCache from '../src/jobCache.js';
import type { Cron, Execution } from '../src/types.js';

let cache: typeof JobCache;

beforeAll(async () => {
  process.env.PROMPTD_NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-node-'));
  cache = await import('../src/jobCache.js');
});

function execution(overrides: Partial<Execution> = {}): Execution {
  return {
    id: 'e1',
    name: 'once',
    description: '',
    scheduledAt: '2026-09-24T12:00:00.000Z',
    workingDirectory: '',
    useWorktree: false,
    cleanupWorktree: true,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prompt: 'x',
    isActive: true,
    status: 'scheduled',
    createdAt: '2026-09-24T00:00:00.000Z',
    updatedAt: '2026-09-24T00:00:00.000Z',
    firedAt: null,
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
    stoppedBy: null,
    ...overrides,
  };
}

const settings = { maxConcurrentJobs: 2, usageDelayThresholds: { credits: 90, fable: 95, session: 90, weekly: 95 }, defaultWorktreeInclude: '' };

describe('jobCache', () => {
  it('reports a change only when the hub sends something new', () => {
    const work = { crons: [] as Cron[], executions: [execution()], settings };
    expect(cache.replaceJobs(work)).toEqual({ jobsChanged: true, settingsChanged: true });
    expect(cache.replaceJobs(work)).toEqual({ jobsChanged: false, settingsChanged: false });
  });

  it('lays unsent writes back over a stale copy from the hub', async () => {
    await cache.patchExecution('e1', { status: 'running' });
    cache.replaceJobs({ crons: [], executions: [execution({ status: 'scheduled' })], settings });
    expect((await cache.getExecution('e1'))?.status).toBe('running');

    cache.acknowledgePatches(cache.pendingPatches().length);
    cache.replaceJobs({ crons: [], executions: [execution({ status: 'done' })], settings });
    expect((await cache.getExecution('e1'))?.status).toBe('done');
  });

  it('records a run for a job the hub took away without arming it again', async () => {
    cache.replaceJobs({ crons: [], executions: [], settings });
    const written = await cache.patchExecution('e1', { lastRunStatus: 'succeeded' });
    expect(written.lastRunStatus).toBe('succeeded');
    expect(await cache.getExecution('e1')).toBeNull();
    expect(cache.pendingPatches().at(-1)).toMatchObject({ kind: 'execution', id: 'e1' });
  });

  it('adds nothing to lifetime counters the hub has not backfilled', async () => {
    const withoutCounters = { ...execution(), kind: 'execution' as const };
    expect(await cache.countRun(withoutCounters, { status: 'succeeded', seconds: 1, costUsd: 0 })).toEqual({});
  });
});
