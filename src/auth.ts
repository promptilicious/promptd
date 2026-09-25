import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

import express from 'express';
import type { NextFunction, Request, Response, Router } from 'express';
import { getIronSession } from 'iron-session';
import type { IronSession } from 'iron-session';

import { db } from './db.js';

const KEY_LENGTH = 64;
const COST = { N: 2 ** 15, r: 8, p: 1 };
const MAX_MEMORY = 64 * 1024 * 1024;
const HASH_CACHE_MS = 5000;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

export const PASSWORD_HASH_ENV = 'PROMPTD_ADMIN_PASSWORD_HASH';
const PASSWORD_HASH_KEY = 'adminPasswordHash';
const SESSION_SECRET_KEY = 'sessionSecret';

// Reachable without a session: the login page and what it loads, and the
// health check, which answers only that a login is needed.
const OPEN_PATHS = new Set(['/login', '/login.html', '/login.js', '/styles.css', '/favicon.ico', '/api/health']);

export interface SessionData {
  authenticated?: boolean;
  passwordStamp?: string;
}

interface ScryptParameters {
  N: number;
  r: number;
  p: number;
}

function deriveKey(password: string, salt: Buffer, cost: ScryptParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...cost, maxmem: MAX_MEMORY }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$hash`, with the salt and hash in base64. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, COST);
  return ['scrypt', COST.N, COST.r, COST.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (![cost.N, cost.r, cost.p].every(Number.isInteger)) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await deriveKey(password, Buffer.from(salt, 'base64'), cost).catch(() => null);
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

async function readSecret(key: string): Promise<string | null> {
  const row = await db().selectFrom('secrets').select('value').where('key', '=', key).executeTakeFirst();
  return row?.value ?? null;
}

async function writeSecret(key: string, value: string): Promise<void> {
  await db()
    .insertInto('secrets')
    .values({ key, value })
    .onConflict((conflict) => conflict.column('key').doUpdateSet({ value }))
    .execute();
}

let cachedHash: { value: string | null; at: number } | null = null;

/** The environment wins over the database, so a deployment's secret store stays the one source of truth. */
export async function adminPasswordHash(): Promise<string | null> {
  const fromEnv = process.env[PASSWORD_HASH_ENV]?.trim();
  if (fromEnv) return fromEnv;
  if (cachedHash && Date.now() - cachedHash.at < HASH_CACHE_MS) return cachedHash.value;
  cachedHash = { value: await readSecret(PASSWORD_HASH_KEY), at: Date.now() };
  return cachedHash.value;
}

export async function setAdminPassword(password: string): Promise<void> {
  await writeSecret(PASSWORD_HASH_KEY, await hashPassword(password));
  cachedHash = null;
}

export async function clearAdminPassword(): Promise<void> {
  await db().deleteFrom('secrets').where('key', '=', PASSWORD_HASH_KEY).execute();
  cachedHash = null;
}

async function sessionSecret(): Promise<string> {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) {
    if (fromEnv.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
    return fromEnv;
  }
  const stored = await readSecret(SESSION_SECRET_KEY);
  if (stored) return stored;
  const generated = randomBytes(32).toString('hex');
  await writeSecret(SESSION_SECRET_KEY, generated);
  return generated;
}

/** Ties a session to the password it was opened with, so changing the password signs everyone out. */
function stampOf(hash: string): string {
  return createHash('sha256').update(hash).digest('hex').slice(0, 16);
}

export function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '::1' || /^127\./.test(host);
}

/** A hub other machines can reach must never come up with the page open to all of them. */
export async function assertAuthConfigured(host: string): Promise<void> {
  await sessionSecret();
  if (isLoopbackHost(host) || (await adminPasswordHash())) return;
  throw new Error(
    `HOST is ${host}, so the page is reachable from other machines, but no admin password is set. ` +
      `Run npm run set-password, or set ${PASSWORD_HASH_ENV}, then start again.`,
  );
}

async function openSession(req: Request, res: Response): Promise<IronSession<SessionData>> {
  const secure = req.protocol === 'https' || req.get('x-forwarded-proto') === 'https';
  return getIronSession<SessionData>(req, res, {
    cookieName: 'promptd_session',
    password: await sessionSecret(),
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: { httpOnly: true, sameSite: 'lax', secure, path: '/' },
  });
}

async function isSignedIn(req: Request, res: Response, hash: string): Promise<boolean> {
  const session = await openSession(req, res);
  return Boolean(session.authenticated) && session.passwordStamp === stampOf(hash);
}

const failures = new Map<string, { count: number; firstAt: number }>();

function lockedOutFor(ip: string): number {
  const entry = failures.get(ip);
  if (!entry) return 0;
  const remaining = entry.firstAt + FAILURE_WINDOW_MS - Date.now();
  if (remaining <= 0) {
    failures.delete(ip);
    return 0;
  }
  return entry.count >= MAX_FAILURES ? remaining : 0;
}

function recordFailure(ip: string): void {
  const entry = failures.get(ip);
  if (entry && Date.now() - entry.firstAt < FAILURE_WINDOW_MS) entry.count += 1;
  else failures.set(ip, { count: 1, firstAt: Date.now() });
}

export function resetLoginFailures(): void {
  failures.clear();
}

export function authRouter(): Router {
  const router = express.Router();

  router.get('/api/auth/status', async (req, res, next) => {
    try {
      const hash = await adminPasswordHash();
      res.json({ required: Boolean(hash), authenticated: hash ? await isSignedIn(req, res, hash) : true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/login', express.json({ limit: '10kb' }), async (req, res, next) => {
    try {
      const ip = req.ip ?? 'unknown';
      const waitMs = lockedOutFor(ip);
      if (waitMs) {
        res.set('Retry-After', String(Math.ceil(waitMs / 1000)));
        return res.status(429).json({ error: `too many failed attempts; try again in ${Math.ceil(waitMs / 60000)} minute(s)` });
      }
      const hash = await adminPasswordHash();
      if (!hash) return res.status(409).json({ error: 'no password is set, so there is nothing to sign in to' });
      const body: unknown = req.body;
      const password = typeof body === 'object' && body !== null && 'password' in body ? body.password : undefined;
      if (typeof password !== 'string' || !(await verifyPassword(password, hash))) {
        recordFailure(ip);
        return res.status(401).json({ error: 'wrong password' });
      }
      failures.delete(ip);
      const session = await openSession(req, res);
      session.authenticated = true;
      session.passwordStamp = stampOf(hash);
      await session.save();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/auth/logout', async (req, res, next) => {
    try {
      (await openSession(req, res)).destroy();
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/**
 * Lets a request through when no password is set, or when it carries a session
 * opened with the current one. Otherwise an API call gets 401 and a page gets
 * sent to the login form. `res.locals.signedIn` tells the open health check
 * which answer to give.
 */
export function requireLogin() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const hash = await adminPasswordHash();
      const signedIn = !hash || (await isSignedIn(req, res, hash));
      res.locals.signedIn = signedIn;
      if (signedIn || OPEN_PATHS.has(req.path)) return next();
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'sign in required' });
        return;
      }
      res.redirect(302, '/login');
    } catch (err) {
      next(err);
    }
  };
}
