import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_USAGE_THRESHOLDS, normalizeUsageDelay, setUsageThresholds, usageBlockers } from '../src/usage.js';
import type { UsageReading, UsageWindow } from '../src/types.js';

function usageWindow(overrides: Partial<UsageWindow>): UsageWindow {
  return {
    key: 'session:0',
    kind: 'session',
    scope: null,
    label: 'Session',
    detail: 'Current 5-hour session',
    usedPercent: 50,
    severity: 'normal',
    resetsAt: '2026-09-24T19:00:00.000Z',
    ...overrides,
  };
}

function reading(windows: UsageWindow[]): UsageReading {
  return { ok: true, reason: null, windows, checkedAt: '2026-09-24T16:00:00.000Z', stale: false };
}

afterEach(() => {
  setUsageThresholds(DEFAULT_USAGE_THRESHOLDS);
});

describe('usageBlockers', () => {
  it('holds a ticked category at or over its threshold', () => {
    const blockers = usageBlockers(reading([usageWindow({ usedPercent: 90 })]), normalizeUsageDelay({ session: true }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ id: 'session', usedPercent: 90, threshold: 90 });
  });

  it('ignores categories the job did not tick', () => {
    expect(usageBlockers(reading([usageWindow({ usedPercent: 99 })]), normalizeUsageDelay({ weekly: true }))).toEqual([]);
  });

  it('never holds on an empty reading', () => {
    expect(usageBlockers(reading([]), normalizeUsageDelay({ session: true }))).toEqual([]);
  });

  it('follows the thresholds in force', () => {
    setUsageThresholds({ ...DEFAULT_USAGE_THRESHOLDS, session: 50 });
    expect(usageBlockers(reading([usageWindow({ usedPercent: 50 })]), normalizeUsageDelay({ session: true }))).toHaveLength(1);
  });

  it('matches the Fable limit by scope', () => {
    const fable = usageWindow({ key: 'weekly_scoped:Fable', kind: 'weekly_scoped', scope: 'Fable', label: 'Weekly · Fable', usedPercent: 96 });
    expect(usageBlockers(reading([fable]), normalizeUsageDelay({ fable: true }))[0]?.id).toBe('fable');
  });
});
