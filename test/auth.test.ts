import fs from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type * as AuthModule from '../src/auth.js';
import type * as DbModule from '../src/db.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptd-auth-'));
process.env.PROMPTD_HOME = home;

let auth: typeof AuthModule;
let dbModule: typeof DbModule;
let server: Server;
let base: string;

beforeAll(async () => {
  dbModule = await import('../src/db.js');
  auth = await import('../src/auth.js');
  dbModule.openDatabase(`sqlite:${path.join(home, 'auth.sqlite')}`);
  await dbModule.migrate();

  const app = express();
  app.use(auth.authRouter());
  app.use(auth.requireLogin());
  app.get('/login', (_req, res) => res.send('login page'));
  app.get('/api/health', (_req, res) => res.json(res.locals.signedIn === false ? { ok: true, authRequired: true } : { ok: true, detail: 'full' }));
  app.get('/api/crons', (_req, res) => res.json([{ name: 'secret job' }]));
  app.get('/', (_req, res) => res.send('the app'));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await dbModule.closeDatabase();
});

beforeEach(async () => {
  await auth.clearAdminPassword();
  auth.resetLoginFailures();
  delete process.env[auth.PASSWORD_HASH_ENV];
});

async function signIn(password: string): Promise<{ status: number; cookie: string }> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { status: res.status, cookie: res.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ') };
}

describe('password hashing', () => {
  it('verifies the right password and rejects a wrong one', async () => {
    const hash = await auth.hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await auth.verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await auth.verifyPassword('correct horse batterx', hash)).toBe(false);
  });

  it('salts every hash differently', async () => {
    expect(await auth.hashPassword('same password here')).not.toBe(await auth.hashPassword('same password here'));
  });

  it('rejects a malformed stored hash instead of throwing', async () => {
    expect(await auth.verifyPassword('anything', 'not-a-hash')).toBe(false);
    expect(await auth.verifyPassword('anything', 'scrypt$x$y$z$abc$def')).toBe(false);
  });
});

describe('the login gate', () => {
  it('stays open while no password is set', async () => {
    expect((await fetch(`${base}/api/crons`)).status).toBe(200);
    expect(await (await fetch(`${base}/api/auth/status`)).json()).toEqual({ required: false, authenticated: true });
  });

  it('answers 401 for the API and redirects pages once a password is set', async () => {
    await auth.setAdminPassword('a long enough password');
    expect((await fetch(`${base}/api/crons`)).status).toBe(401);
    const page = await fetch(`${base}/`, { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe('/login');
    expect((await fetch(`${base}/login`)).status).toBe(200);
  });

  it('tells a signed-out health check only that a login is needed', async () => {
    await auth.setAdminPassword('a long enough password');
    expect(await (await fetch(`${base}/api/health`)).json()).toEqual({ ok: true, authRequired: true });
  });

  it('lets a signed-in session through until it signs out', async () => {
    await auth.setAdminPassword('a long enough password');
    expect((await signIn('wrong one entirely')).status).toBe(401);
    const { status, cookie } = await signIn('a long enough password');
    expect(status).toBe(200);
    expect(cookie).toContain('promptd_session=');
    expect((await fetch(`${base}/api/crons`, { headers: { cookie } })).status).toBe(200);

    const out = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie } });
    const cleared = out.headers.getSetCookie().map((part) => part.split(';')[0]).join('; ');
    expect((await fetch(`${base}/api/crons`, { headers: { cookie: cleared } })).status).toBe(401);
  });

  it('signs every session out when the password changes', async () => {
    await auth.setAdminPassword('the first password');
    const { cookie } = await signIn('the first password');
    await auth.setAdminPassword('the second password');
    expect((await fetch(`${base}/api/crons`, { headers: { cookie } })).status).toBe(401);
  });

  it('locks out an address after five failures', async () => {
    await auth.setAdminPassword('a long enough password');
    for (let attempt = 0; attempt < 5; attempt += 1) expect((await signIn('nope nope nope')).status).toBe(401);
    const locked = await signIn('a long enough password');
    expect(locked.status).toBe(429);
  });

  it('prefers a hash from the environment over the stored one', async () => {
    await auth.setAdminPassword('the stored password');
    process.env[auth.PASSWORD_HASH_ENV] = await auth.hashPassword('the env password');
    expect((await signIn('the stored password')).status).toBe(401);
    expect((await signIn('the env password')).status).toBe(200);
  });
});

describe('assertAuthConfigured', () => {
  it('allows an open hub on loopback only', async () => {
    await expect(auth.assertAuthConfigured('127.0.0.1')).resolves.toBeUndefined();
    await expect(auth.assertAuthConfigured('0.0.0.0')).rejects.toThrow('no admin password is set');
    await auth.setAdminPassword('a long enough password');
    await expect(auth.assertAuthConfigured('0.0.0.0')).resolves.toBeUndefined();
  });
});
