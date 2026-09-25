import { describe, expect, it } from 'vitest';

import { countRun, hasLifetimeStats, readLogStats } from '../src/stats.js';
import type { Cron } from '../src/types.js';

const footer = [
  '--- output ---',
  'text that mentions --- failed after 1.0s --- in passing',
  '=-----------------------------------=',
  'Cost: $0.0123',
  '=-----------------------------------=',
  '',
  '--- succeeded after 9.5s (exit code 0) ---',
].join('\n');

describe('readLogStats', () => {
  it('reads the last footer and cost, ignoring look-alikes in the output', () => {
    expect(readLogStats(footer)).toEqual({ status: 'succeeded', seconds: 9.5, costUsd: 0.0123 });
  });

  it('reports a run with no footer as unfinished', () => {
    expect(readLogStats('--- output ---\nstill going')).toEqual({ status: null, seconds: null, costUsd: null });
  });

  it('leaves an unknown cost null', () => {
    expect(readLogStats('Cost: unknown\n--- stopped after 2.0s (killed by user) ---').costUsd).toBeNull();
  });
});

function cronWithCounters(overrides: Partial<Cron> = {}): Cron {
  return {
    id: 'c1',
    name: 'nightly',
    description: '',
    cron: '0 9 * * *',
    workingDirectory: '',
    useWorktree: false,
    cleanupWorktree: false,
    model: '',
    effort: '',
    usageDelay: { credits: false, fable: false, session: false, weekly: false },
    prompt: 'hi',
    isActive: true,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunLog: null,
    lifetimeRuns: 2,
    lifetimeCostUsd: 1.5,
    lifetimeRuntimeSeconds: 20,
    ...overrides,
  };
}

describe('countRun', () => {
  it('adds a successful run to existing counters', async () => {
    expect(await countRun(cronWithCounters(), { status: 'succeeded', seconds: 4.25, costUsd: 0.1 })).toEqual({
      lifetimeRuns: 3,
      lifetimeCostUsd: 1.6,
      lifetimeRuntimeSeconds: 24.3,
    });
  });

  it('counts nothing for a run that did not succeed', async () => {
    expect(await countRun(cronWithCounters(), { status: 'failed', seconds: 4, costUsd: 0.1 })).toEqual({});
  });

  it('treats a missing cost as zero', async () => {
    const result = await countRun(cronWithCounters(), { status: 'succeeded', seconds: 1, costUsd: undefined });
    expect(result.lifetimeCostUsd).toBe(1.5);
  });

  it('knows when a record has no counters yet', () => {
    expect(hasLifetimeStats(cronWithCounters())).toBe(true);
    expect(hasLifetimeStats(cronWithCounters({ lifetimeRuns: undefined }))).toBe(false);
  });
});
