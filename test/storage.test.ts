import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as DbModule from '../src/db.js';
import type * as ExecutionsModule from '../src/executions.js';
import type * as LegacyModule from '../src/legacyImport.js';
import type * as SettingsModule from '../src/settings.js';
import type * as StoreModule from '../src/store.js';
import type { CronInput } from '../src/types.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-storage-'));
process.env.PROMPTD_HOME = home;

let dbModule: typeof DbModule;
let store: typeof StoreModule;
let executions: typeof ExecutionsModule;
let settings: typeof SettingsModule;
let legacy: typeof LegacyModule;

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  store = await import('../src/store.js');
  executions = await import('../src/executions.js');
  settings = await import('../src/settings.js');
  legacy = await import('../src/legacyImport.js');
});

afterAll(async () => {
  await dbModule.closeDatabase();
});

const targets = [
  { name: 'sqlite', url: `sqlite:${path.join(home, 'test.sqlite')}` },
  ...(process.env.TEST_DATABASE_URL ? [{ name: 'postgres', url: process.env.TEST_DATABASE_URL }] : []),
];

const cronInput: CronInput = {
  name: 'Nightly digest',
  description: 'Summarize the day',
  cron: '0 9 * * *',
  workingDirectory: '~/code',
  useWorktree: true,
  cleanupWorktree: false,
  model: 'sonnet',
  effort: 'high',
  usageDelay: { credits: false, fable: false, session: true, weekly: false },
  prompt: 'Write two lines.',
  isActive: true,
  nodeId: '',
};

describe.each(targets)('storage on $name', ({ url }) => {
  beforeAll(async () => {
    await dbModule.closeDatabase();
    dbModule.openDatabase(url);
    await dbModule.migrate();
  });

  beforeEach(async () => {
    const db = dbModule.db();
    for (const table of ['crons', 'executions', 'notifications', 'settings', 'nodes'] as const) {
      await db.deleteFrom(table).execute();
    }
  });

  it('keeps a cron exactly as it was saved', async () => {
    const created = await store.createCron(cronInput);
    expect(await store.getCron(created.id)).toEqual(created);
    expect(created.lifetimeRuns).toBeUndefined();
  });

  it('lists crons by name', async () => {
    await store.createCron({ ...cronInput, name: 'b' });
    await store.createCron({ ...cronInput, name: 'a' });
    expect((await store.listCrons()).map((cron) => cron.name)).toEqual(['a', 'b']);
  });

  it('records run bookkeeping and fractional counters', async () => {
    const { id } = await store.createCron(cronInput);
    await store.patchCron(id, { lastRunStatus: 'succeeded', lifetimeRuns: 3, lifetimeCostUsd: 1.2345, lifetimeRuntimeSeconds: 61.5 });
    expect(await store.getCron(id)).toMatchObject({ lastRunStatus: 'succeeded', lifetimeRuns: 3, lifetimeCostUsd: 1.2345, lifetimeRuntimeSeconds: 61.5 });
  });

  it('keeps run bookkeeping through an edit', async () => {
    const { id } = await store.createCron(cronInput);
    await store.patchCron(id, { lifetimeRuns: 4 });
    const updated = await store.updateCron(id, { ...cronInput, name: 'Renamed', isActive: false });
    expect(updated).toMatchObject({ name: 'Renamed', isActive: false, lifetimeRuns: 4 });
    expect(await store.getCron(id)).toEqual(updated);
  });

  it('deletes a cron once', async () => {
    const { id } = await store.createCron(cronInput);
    expect(await store.deleteCron(id)).toBe(true);
    expect(await store.deleteCron(id)).toBe(false);
    expect(await store.getCron(id)).toBeNull();
  });

  it('re-arms an execution whose date moves, and pages newest first', async () => {
    const early = await executions.createExecution({ ...cronInput, scheduledAt: '2026-01-01T00:00:00.000Z' });
    const late = await executions.createExecution({ ...cronInput, scheduledAt: '2026-06-01T00:00:00.000Z' });
    await executions.patchExecution(early.id, { status: 'done', firedAt: '2026-01-01T00:00:01.000Z' });

    const rescheduled = await executions.updateExecution(early.id, { ...cronInput, scheduledAt: '2027-01-01T00:00:00.000Z' });
    expect(rescheduled).toMatchObject({ status: 'scheduled', firedAt: null, cleanupWorktree: true });

    const first = await executions.pageExecutions({ limit: 1 });
    expect(first.items.map((item) => item.id)).toEqual([early.id]);
    expect(first).toMatchObject({ total: 2, scheduled: 2 });
    const second = await executions.pageExecutions({ before: first.nextBefore, limit: 1 });
    expect(second.items.map((item) => item.id)).toEqual([late.id]);
    expect(second.nextBefore).toBeNull();
  });

  it('writes the default settings once and patches one key without touching others', async () => {
    const defaults = await settings.loadSettings();
    expect(defaults.selfUpdate).toBe(true);
    await settings.patchSettings({ serverName: 'Office' });
    await settings.patchSettings({ maxConcurrentJobs: 3 });
    expect(await settings.loadSettings()).toMatchObject({ serverName: 'Office', maxConcurrentJobs: 3, selfUpdate: true });
  });

  it('fills a threshold missing from the stored set', async () => {
    await settings.patchSettings({ usageDelayThresholds: { session: 50 } as never });
    expect((await settings.loadSettings()).usageDelayThresholds).toEqual({ session: 50, weekly: 95, fable: 95, credits: 90 });
  });

  it('imports an install from before the database, once', async () => {
    fs.mkdirSync(path.join(home, 'crons'), { recursive: true });
    fs.mkdirSync(path.join(home, 'executions'), { recursive: true });
    fs.writeFileSync(path.join(home, 'crons', 'c1.json'), JSON.stringify({ id: 'c1', name: 'Old cron', cron: '*/5 * * * *', isActive: true, lifetimeRuns: 7 }));
    fs.writeFileSync(path.join(home, 'executions', 'e1.json'), JSON.stringify({ id: 'e1', name: 'Old once', scheduledAt: '2026-01-01T00:00:00.000Z', status: 'scheduled' }));
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ serverName: 'Legacy', maxConcurrentJobs: 2 }));

    expect(await legacy.importLegacyFiles()).toMatchObject({ crons: 1, executions: 1, settings: true });
    expect(await store.getCron('c1')).toMatchObject({ name: 'Old cron', cron: '*/5 * * * *', isActive: true, lifetimeRuns: 7, nodeId: '' });
    expect(await executions.getExecution('e1')).toMatchObject({ status: 'scheduled', cleanupWorktree: true });
    expect(await settings.loadSettings()).toMatchObject({ serverName: 'Legacy', maxConcurrentJobs: 2 });
    expect(await legacy.importLegacyFiles()).toBeNull();

    fs.rmSync(path.join(home, 'crons'), { recursive: true });
    fs.rmSync(path.join(home, 'executions'), { recursive: true });
    fs.rmSync(path.join(home, 'settings.json'));
  });
});
