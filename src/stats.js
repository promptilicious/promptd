import fsp from 'node:fs/promises';
import path from 'node:path';
import { listLogs, logDir, patchCron } from './store.js';

/**
 * Lifetime totals per cron: how many runs it has completed, what they cost, and
 * how long they took. Kept on the cron file so they outlive the logs, which are
 * pruned past the newest 50.
 *
 * A cron written before these existed has none, so the first time they are asked
 * for they are read back out of the logs still on disk and written down. That is
 * a floor rather than a true lifetime figure — anything already pruned is gone —
 * and every run after it is counted exactly once, as it finishes.
 */
export const LIFETIME_FIELDS = ['lifetimeRuns', 'lifetimeCostUsd', 'lifetimeRuntimeSeconds'];

/**
 * A finished log keeps its statistics block and its footer at the very end, so
 * only the tail is read. 4 KB covers both many times over; a run whose output is
 * megabytes of text is then read in kilobytes.
 */
const TAIL_BYTES = 4096;

/** Money to the cent-fraction the CLI reports; seconds to a tenth, as logged. */
const round4 = (value) => Math.round(value * 1e4) / 1e4;
const round1 = (value) => Math.round(value * 10) / 10;

export function hasLifetimeStats(cron) {
  return LIFETIME_FIELDS.every((field) => Number.isFinite(cron?.[field]));
}

/** The last bytes of a file, or null when it cannot be read. */
async function readTail(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * What one log records about its run: how it ended, how long it took, and what
 * it cost.
 *
 * Both lines are matched last-first. A run's own output can contain anything,
 * including text shaped like a footer, and the real one is always at the end.
 * A log with no footer belongs to a run that has not finished — it is not a
 * completed execution, and `status` is null to say so.
 */
export function readLogStats(tail) {
  const outcome = [...String(tail ?? '').matchAll(/^--- (\w+) after ([\d.]+)s/gm)].at(-1);
  const cost = [...String(tail ?? '').matchAll(/^Cost: \$([\d.]+)\s*$/gm)].at(-1);
  return {
    status: outcome?.[1] ?? null,
    seconds: outcome ? Number(outcome[2]) : null,
    // A run the CLI never reported a cost for — it died early, or was stopped —
    // logs "Cost: unknown", which is not a number and is left null.
    costUsd: cost ? Number(cost[1]) : null,
  };
}

/**
 * The totals read back out of a cron's logs.
 *
 * Only runs that succeeded are counted, which is the same rule the live counter
 * follows, so the backfilled numbers and everything added after them mean one
 * thing. A run still being written has no footer and is skipped: it is counted
 * by its own finish instead, which is what keeps it from landing twice.
 */
export async function backfillStats(cronName) {
  const totals = { lifetimeRuns: 0, lifetimeCostUsd: 0, lifetimeRuntimeSeconds: 0 };
  for (const log of await listLogs(cronName)) {
    const stats = readLogStats(await readTail(path.join(logDir(cronName), log.file)));
    if (stats.status !== 'succeeded') continue;
    totals.lifetimeRuns += 1;
    totals.lifetimeCostUsd += stats.costUsd ?? 0;
    totals.lifetimeRuntimeSeconds += stats.seconds ?? 0;
  }
  totals.lifetimeCostUsd = round4(totals.lifetimeCostUsd);
  totals.lifetimeRuntimeSeconds = round1(totals.lifetimeRuntimeSeconds);
  return totals;
}

/**
 * The counter fields to write once a run has finished and its log is closed.
 *
 * A cron with no counters yet is read off its log folder, which by then already
 * holds this run's finished log — so that pass counts it and there is nothing
 * left to add. Otherwise a successful run adds itself, and a failed or stopped
 * one changes nothing.
 */
export async function countRun(cron, { status, seconds, costUsd }) {
  if (!hasLifetimeStats(cron)) return backfillStats(cron.name);
  if (status !== 'succeeded') return {};
  return {
    lifetimeRuns: cron.lifetimeRuns + 1,
    lifetimeCostUsd: round4(cron.lifetimeCostUsd + (Number.isFinite(costUsd) ? costUsd : 0)),
    lifetimeRuntimeSeconds: round1(cron.lifetimeRuntimeSeconds + (Number.isFinite(seconds) ? seconds : 0)),
  };
}

/**
 * The cron's lifetime figures, with the per-run averages the page draws.
 *
 * Counters missing from the cron file are read out of the logs here and written
 * back, so the scan happens once rather than on every visit. Averages are over
 * completed runs, and are null when there have been none — a cron that has never
 * finished a run has no average cost, and 0 would be a different claim.
 */
export async function lifetimeStats(cron) {
  let totals = cron;
  if (!hasLifetimeStats(cron)) {
    totals = await backfillStats(cron.name);
    await patchCron(cron.id, totals).catch((err) =>
      console.error(`[stats] could not record lifetime totals for "${cron.name}": ${err.message}`),
    );
  }
  const runs = totals.lifetimeRuns;
  return {
    runs,
    costUsd: totals.lifetimeCostUsd,
    runtimeSeconds: totals.lifetimeRuntimeSeconds,
    averageCostUsd: runs > 0 ? round4(totals.lifetimeCostUsd / runs) : null,
    averageRuntimeSeconds: runs > 0 ? round1(totals.lifetimeRuntimeSeconds / runs) : null,
  };
}
