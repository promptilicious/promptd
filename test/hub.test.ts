import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import type * as HubModule from '../src/hub.js';

let hub: (typeof HubModule)['hub'];
let logsDir: string;

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-hub-'));
  process.env.PROMPTD_HOME = home;
  logsDir = path.join(home, 'logs');
  ({ hub } = await import('../src/hub.js'));
});

function chunk(offset: number, text: string): { jobId: string; file: string; offset: number; data: string } {
  return { jobId: 'job-1', file: '2026-09-24T16-00-00.000Z.txt', offset, data: Buffer.from(text).toString('base64') };
}

function hubLog(): string {
  return fs.readFileSync(path.join(logsDir, 'job-1', '2026-09-24T16-00-00.000Z.txt'), 'utf8');
}

describe('writeLogChunk', () => {
  it('appends chunks in order and answers the new size', async () => {
    expect(await hub.writeLogChunk(chunk(0, 'hello '))).toBe(6);
    expect(await hub.writeLogChunk(chunk(6, 'wörld'))).toBe(12);
    expect(hubLog()).toBe('hello wörld');
  });

  it('lands a replayed chunk on the same bytes', async () => {
    expect(await hub.writeLogChunk(chunk(6, 'wörld'))).toBe(12);
    expect(hubLog()).toBe('hello wörld');
  });

  it('refuses a chunk past the end and rewinds the node to what it holds', async () => {
    expect(await hub.writeLogChunk(chunk(50, 'lost'))).toBe(12);
    expect(hubLog()).toBe('hello wörld');
  });

  it('rejects a log name that would escape the logs folder', async () => {
    await expect(hub.writeLogChunk({ ...chunk(0, 'x'), file: '../../etc/passwd' })).rejects.toThrow('invalid log file name');
  });
});
