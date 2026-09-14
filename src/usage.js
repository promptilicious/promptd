import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

/**
 * Subscription usage for the account the Claude CLI is signed in as.
 *
 * The CLI's own `/usage` view is interactive, so there is nothing to shell out
 * to. It reads these numbers from the OAuth usage endpoint, which is what this
 * does: borrow the CLI's stored access token and ask directly.
 */
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
// OAuth tokens are only accepted on this endpoint with the beta opt-in header.
const OAUTH_BETA = 'oauth-2025-04-20';

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const CREDENTIALS_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

// Usage moves slowly and every open tab polls /api/health, so the answer is
// cached rather than fetched per request.
const TTL_MS = 60 * 1000;
// A failed lookup should not retry on every poll either.
const ERROR_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Names for the limit kinds the endpoint reports. The response also carries a
 * long tail of unreleased, all-null limit keys, so the `limits` array is read
 * instead of those: it is already normalized, and a kind added later still
 * renders off its own name rather than being dropped.
 */
const KIND_LABELS = {
  session: { label: 'Session', detail: 'Current 5-hour session' },
  weekly_all: { label: 'Weekly', detail: 'Rolling 7-day limit, all models' },
  weekly_scoped: { label: 'Weekly', detail: 'Rolling 7-day limit' },
};

/** "weekly_all" -> "Weekly all", so an unknown future kind is still readable. */
function humanize(kind) {
  const text = String(kind ?? '').replace(/[_-]+/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Limit';
}

/** The CLI keeps its credentials in the login keychain on macOS. */
function keychainCredentials() {
  return new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: 10000 },
      (err, stdout) => resolve(err ? null : String(stdout).trim() || null),
    );
  });
}

/**
 * The access token the CLI is using, or null when it is not signed in.
 *
 * Deliberately read fresh each time rather than held in memory: the CLI rotates
 * this token, and a copy we kept would go stale. It is never logged, never
 * cached, and never leaves this module.
 */
async function accessToken() {
  let raw = null;
  if (process.platform === 'darwin') raw = await keychainCredentials();
  if (!raw) raw = await fsp.readFile(CREDENTIALS_FILE, 'utf8').catch(() => null);
  if (!raw) return { token: null, reason: 'the Claude CLI is not signed in on this machine' };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { token: null, reason: 'stored Claude credentials could not be read' };
  }

  const oauth = parsed?.claudeAiOauth ?? parsed;
  const token = oauth?.accessToken;
  if (!token) return { token: null, reason: 'stored Claude credentials carry no access token' };
  // An expired token is reported as its own state rather than refreshed here:
  // refreshing rotates the CLI's refresh token underneath it, so that is the
  // CLI's job, not ours.
  if (Number.isFinite(oauth.expiresAt) && oauth.expiresAt <= Date.now()) {
    return { token: null, reason: 'the stored Claude login has expired; run any claude command to refresh it' };
  }
  return { token, reason: null };
}

function percent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Math.max(0, Math.min(100, Math.round(number * 10) / 10));
}

function isoOrNull(value) {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toISOString();
}

/** One entry of the endpoint's `limits` array, in the shape the page draws. */
function readLimit(entry, index) {
  const used = percent(entry?.percent);
  if (used === null) return null;
  const known = KIND_LABELS[entry.kind];
  // A scoped limit names what it is scoped to, e.g. "Weekly · Fable".
  const scope = entry?.scope?.model?.display_name ?? entry?.scope?.surface ?? null;
  const label = known?.label ?? humanize(entry.kind);
  return {
    key: `${entry.kind ?? 'limit'}:${scope ?? index}`,
    label: scope ? `${label} · ${scope}` : label,
    detail: scope ? `${known?.detail ?? label} — ${scope}` : (known?.detail ?? label),
    usedPercent: used,
    severity: entry?.severity === 'critical' || entry?.severity === 'warning' ? entry.severity : 'normal',
    resetsAt: isoOrNull(entry?.resets_at),
  };
}

/** Money is reported in minor units with its own exponent, e.g. 272985 / 10^2. */
function money(amount) {
  if (!Number.isFinite(amount?.amount_minor)) return null;
  const value = amount.amount_minor / 10 ** (amount.exponent ?? 2);
  try {
    return value.toLocaleString('en-US', { style: 'currency', currency: amount.currency ?? 'USD' });
  } catch {
    return `${value.toFixed(2)} ${amount.currency ?? ''}`.trim();
  }
}

/**
 * Extra usage credits, which are a spend cap rather than a rate limit: they
 * have no reset time, and are only shown when the account has them turned on.
 */
function readSpend(spend) {
  const used = percent(spend?.percent);
  if (used === null || !spend?.enabled) return null;
  const spent = money(spend.used);
  const cap = money(spend.limit);
  return {
    key: 'spend',
    label: 'Credits',
    detail: spent && cap ? `${spent} of ${cap} extra usage credits` : 'Extra usage credits',
    usedPercent: used,
    severity: spend?.severity === 'critical' || spend?.severity === 'warning' ? spend.severity : 'normal',
    resetsAt: null,
  };
}

async function fetchUsage() {
  const { token, reason } = await accessToken();
  if (!token) return { ok: false, reason, windows: [] };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'the stored Claude login was rejected; sign in again with the CLI', windows: [] };
    }
    if (!res.ok) return { ok: false, reason: `usage lookup failed (${res.status})`, windows: [] };

    const body = await res.json();
    const windows = [
      ...(Array.isArray(body?.limits) ? body.limits.map(readLimit).filter(Boolean) : []),
      readSpend(body?.spend),
    ].filter(Boolean);
    if (!windows.length) return { ok: false, reason: 'no usage limits reported for this account', windows: [] };
    return { ok: true, reason: null, windows };
  } catch (err) {
    const reason = err.name === 'AbortError' ? 'usage lookup timed out' : `usage lookup failed: ${err.message}`;
    return { ok: false, reason, windows: [] };
  } finally {
    clearTimeout(timer);
  }
}

class UsageMonitor {
  constructor() {
    this.cached = null;
    this.expiresAt = 0;
    /** Shared so concurrent polls make one request, not one each. @type {Promise|null} */
    this.inFlight = null;
  }

  /**
   * The current reading. Never throws, and never waits on the network once
   * something is cached — a health check must not hang on Anthropic being slow.
   */
  async state() {
    if (this.cached && Date.now() < this.expiresAt) return this.cached;
    if (!this.inFlight) {
      this.inFlight = fetchUsage()
        .then((result) => {
          this.cached = { ...result, checkedAt: new Date().toISOString() };
          this.expiresAt = Date.now() + (result.ok ? TTL_MS : ERROR_TTL_MS);
          return this.cached;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    // A stale reading beats making the page wait; the next poll picks up the new one.
    return this.cached ?? this.inFlight;
  }
}

export const usageMonitor = new UsageMonitor();
