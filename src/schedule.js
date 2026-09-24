import { Cron } from 'croner';

/**
 * The durations the Pause triggers for control offers. `ms: null` means "no timer" — the
 * pause is only lifted by cancelling it or by the process restarting, since the
 * pause is never written to disk.
 */
export const PAUSE_OPTIONS = [
  { id: '30m', label: '30 minutes', ms: 30 * 60 * 1000 },
  { id: '1h', label: '1 hour', ms: 60 * 60 * 1000 },
  { id: '3h', label: '3 hours', ms: 3 * 60 * 60 * 1000 },
  { id: 'restart', label: 'until restart', ms: null },
];

/**
 * The effort levels the CLI accepts for `--effort`. An empty effort on a cron
 * means the flag is left off, so the CLI uses whatever it is configured to use.
 */
export const EFFORT_LEVELS = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Max' },
];

export function isEffortLevel(value) {
  return EFFORT_LEVELS.some((level) => level.id === value);
}

export function pauseOption(id) {
  return PAUSE_OPTIONS.find((option) => option.id === id) ?? null;
}

export function validateCronExpression(expression) {
  try {
    const probe = new Cron(String(expression).trim(), { paused: true });
    if (!probe.nextRun()) return { ok: false, error: 'expression has no future run times' };
    probe.stop();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Next fire time for an expression, without scheduling anything. */
export function previewNextRun(expression) {
  try {
    const probe = new Cron(String(expression).trim(), { paused: true });
    const next = probe.nextRun();
    probe.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}
