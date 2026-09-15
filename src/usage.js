import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT } from './paths.js';

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

// Usage moves slowly and every open tab polls /api/health, so the endpoint is
// asked once per window at most and every request is answered from the cache.
const TTL_MS = 5 * 60 * 1000;
// A failed lookup backs off, doubling from here: a rate-limited endpoint should
// not be asked again on the same timer that just tripped it.
const ERROR_BACKOFF_MS = 5 * 60 * 1000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10000;
// A delayed cron asks for a reading outside the normal window when the limit it
// is waiting on should have reset. This is the floor on how often that is
// allowed, so a reset time that keeps reading as past cannot become a hot loop.
const FORCED_FETCH_GAP_MS = 60 * 1000;

/**
 * The last good reading, kept across restarts. Only the drawn numbers are
 * written — no token, no raw response — so a restart or a self-update redraws
 * the meters from disk instead of blanking them until the first fetch lands.
 */
const CACHE_FILE = path.join(ROOT, 'usage-cache.json');
// Older than this and a kept reading is not worth showing at all.
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

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
    // Kept alongside the drawn label because the usage-delay categories match on
    // what a limit *is*, not on how it happens to be worded in the header.
    kind: entry.kind ?? null,
    scope,
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
    kind: 'spend',
    scope: null,
    label: 'Credits',
    detail: spent && cap ? `${spent} of ${cap} extra usage credits` : 'Extra usage credits',
    usedPercent: used,
    severity: spend?.severity === 'critical' || spend?.severity === 'warning' ? spend.severity : 'normal',
    resetsAt: null,
  };
}

/**
 * The kind of limit a window reports. Readings kept from an older build predate
 * the `kind` field, so the key — which has always started with the kind — is the
 * fallback rather than letting a restored cache match nothing.
 */
function kindOf(window) {
  return window?.kind ?? String(window?.key ?? '').split(':')[0];
}

/** Local midnight on the first of next month. */
function firstOfNextMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString();
}

/**
 * The usage categories a cron can be told to wait on, each matched against what
 * a limit *is* rather than how the header words it. `blocks` is the threshold
 * that holds a trigger back: a rate limit has to be spent outright, while extra
 * credits are a spending cap, so the cron is held before the money runs out.
 *
 * `matches` and `blocks` are functions, so JSON.stringify drops them and the
 * same array can be handed to the page as the checkbox list.
 */
export const USAGE_DELAY_CATEGORIES = [
  {
    id: 'session',
    label: 'Session',
    hint: 'Hold the trigger while the 5-hour session limit is at 100%.',
    matches: (window) => kindOf(window) === 'session',
    blocks: (used) => used >= 100,
  },
  {
    id: 'weekly',
    label: 'Weekly',
    hint: 'Hold the trigger while the rolling 7-day limit is at 100%.',
    matches: (window) => kindOf(window) === 'weekly_all',
    blocks: (used) => used >= 100,
  },
  {
    id: 'fable',
    label: 'Fable',
    hint: 'Hold the trigger while the Fable weekly limit is at 100%.',
    matches: (window) => kindOf(window) === 'weekly_scoped' && /fable/i.test(window?.scope ?? window?.label ?? ''),
    blocks: (used) => used >= 100,
  },
  {
    id: 'credits',
    label: 'Monthly Credits 90%',
    hint: 'Hold the trigger once more than 90% of the extra usage credits are spent. Credits are monthly, so they clear on the first.',
    matches: (window) => kindOf(window) === 'spend',
    blocks: (used) => used > 90,
    // The endpoint reports no reset time for a spending cap; the cap is monthly.
    resetsAt: () => firstOfNextMonth(),
  },
];

/** Every category, always all four keys, so a cron file never carries a half set. */
export function normalizeUsageDelay(input) {
  const value = {};
  for (const category of USAGE_DELAY_CATEGORIES) value[category.id] = Boolean(input?.[category.id]);
  return value;
}

/** True when at least one category is ticked. */
export function hasUsageDelay(delay) {
  return USAGE_DELAY_CATEGORIES.some((category) => Boolean(delay?.[category.id]));
}

/**
 * Which of a cron's ticked categories are over their threshold right now, and
 * when each of them clears.
 *
 * An empty reading returns nothing on purpose. A signed-out CLI or a rate-limited
 * lookup is not evidence that the account is out of usage, and holding every cron
 * on a reading we do not have would be the worse failure.
 */
export function usageBlockers(reading, delay) {
  const windows = reading?.windows ?? [];
  if (!windows.length) return [];
  const blockers = [];
  for (const category of USAGE_DELAY_CATEGORIES) {
    if (!delay?.[category.id]) continue;
    const window = windows.find((candidate) => category.matches(candidate));
    if (!window || !category.blocks(window.usedPercent)) continue;
    blockers.push({
      id: category.id,
      label: category.label,
      usedPercent: window.usedPercent,
      resetsAt: category.resetsAt ? category.resetsAt() : (window.resetsAt ?? null),
    });
  }
  return blockers;
}

/** `Retry-After` is either a count of seconds or an HTTP date; both appear. */
function retryAfterMs(header) {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 0;
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
    if (!res.ok) {
      // A 429 says how long to wait; anything else falls back to the backoff.
      return {
        ok: false,
        reason: `usage lookup failed (${res.status})`,
        windows: [],
        retryMs: retryAfterMs(res.headers.get('retry-after')),
      };
    }

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

/** Writes the last good reading so a restart does not start from nothing. */
async function persist(reading) {
  try {
    await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
    const tmp = `${CACHE_FILE}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(reading, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, CACHE_FILE);
  } catch {
    // A cache that cannot be written is not worth failing a health check over.
  }
}

/** The kept reading, or null when there is none, it is unreadable, or it is stale. */
async function readCache() {
  try {
    const kept = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'));
    const at = Date.parse(kept?.checkedAt);
    if (!Array.isArray(kept?.windows) || !kept.windows.length) return null;
    if (!Number.isFinite(at) || Date.now() - at > CACHE_MAX_AGE_MS) return null;
    return { windows: kept.windows, checkedAt: new Date(at).toISOString() };
  } catch {
    return null;
  }
}

class UsageMonitor {
  constructor() {
    /** The last reading that carried windows, however old it now is. */
    this.lastGood = null;
    /** Why the most recent refresh failed, or null when it succeeded. */
    this.reason = null;
    /** Earliest the endpoint may be asked again. */
    this.nextFetchAt = 0;
    /** Earliest a delayed cron may ask outside that window. */
    this.nextForcedFetchAt = 0;
    /** Consecutive failures, which is what the backoff doubles on. */
    this.failures = 0;
    /** Shared so concurrent polls make one request, not one each. @type {Promise|null} */
    this.inFlight = null;
    /** The disk read, done once. @type {Promise|null} */
    this.restoring = null;
  }

  /**
   * The current reading. Never throws and never waits on the network: a poll
   * that finds the window open starts a refresh and answers from what is
   * already held, so /api/health stays instant and a page refresh redraws the
   * meters from the last lookup rather than triggering one of its own.
   */
  async state() {
    await this.restore();
    if (Date.now() >= this.nextFetchAt) this.refresh();
    return this.reading();
  }

  /**
   * The current reading, waiting on a lookup rather than answering from the last
   * one. This is what a delayed cron uses the moment the limit it is waiting on
   * should have cleared: answering from a five-minute-old reading there would
   * hold the run back for another five minutes for no reason.
   */
  async now() {
    await this.restore();
    if (Date.now() >= this.nextForcedFetchAt) {
      this.nextForcedFetchAt = Date.now() + FORCED_FETCH_GAP_MS;
      await this.refresh();
    } else if (Date.now() >= this.nextFetchAt) {
      await this.refresh();
    }
    return this.reading();
  }

  reading() {
    const windows = this.lastGood?.windows ?? [];
    const age = this.lastGood ? Date.now() - Date.parse(this.lastGood.checkedAt) : 0;
    return {
      ok: windows.length > 0,
      // Kept even while windows are served, so the page can say why the numbers
      // stopped moving.
      reason: this.reason,
      windows,
      checkedAt: this.lastGood?.checkedAt ?? null,
      // Older than a refresh window means these are last-known numbers, either
      // because a refresh failed or because they came off disk at startup.
      stale: windows.length > 0 && age > TTL_MS,
    };
  }

  /** Starts a refresh unless one is already running. Failures are absorbed. */
  refresh() {
    if (this.inFlight) return this.inFlight;
    // Claim the window before the request goes out, so a slow one cannot let
    // the next poll start a second.
    this.nextFetchAt = Date.now() + TTL_MS;
    this.inFlight = fetchUsage()
      .then((result) => this.record(result))
      // fetchUsage answers rather than throws, so this is only ever a bug here;
      // it still must not surface as an unhandled rejection or blank the meters.
      .catch((err) => this.record({ ok: false, reason: `usage lookup failed: ${err.message}` }))
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /**
   * Folds one lookup into the held state. A failure never clears the last good
   * windows — it only records why they stopped moving and pushes the next
   * attempt further out.
   */
  record(result) {
    if (result.ok) {
      this.lastGood = { windows: result.windows, checkedAt: new Date().toISOString() };
      this.reason = null;
      this.failures = 0;
      this.nextFetchAt = Date.now() + TTL_MS;
      void persist(this.lastGood);
      return;
    }
    this.reason = result.reason;
    this.failures += 1;
    const backoff = Math.min(ERROR_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
    this.nextFetchAt = Date.now() + Math.max(backoff, result.retryMs ?? 0);
  }

  /**
   * The reading kept from a previous run, read once. Its age also sets the next
   * fetch, so a server that restarts repeatedly does not ask on every boot.
   */
  restore() {
    if (this.restoring) return this.restoring;
    this.restoring = readCache().then((kept) => {
      if (!kept || this.lastGood) return;
      this.lastGood = kept;
      this.nextFetchAt = Date.parse(kept.checkedAt) + TTL_MS;
    });
    return this.restoring;
  }
}

export const usageMonitor = new UsageMonitor();
