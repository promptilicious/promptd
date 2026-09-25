import { describe, expect, it } from 'vitest';

import { isEffortLevel, pauseOption, previewNextRun, validateCronExpression } from '../src/schedule.js';

describe('validateCronExpression', () => {
  it('accepts a five-field expression', () => {
    expect(validateCronExpression('0 9 * * *')).toEqual({ ok: true });
  });

  it('rejects garbage with the parser message', () => {
    const result = validateCronExpression('not a cron');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('previewNextRun', () => {
  it('answers a future ISO time for a valid expression', () => {
    const next = previewNextRun('*/5 * * * *');
    expect(next).not.toBeNull();
    expect(Date.parse(next ?? '')).toBeGreaterThan(Date.now());
  });

  it('answers null for an invalid expression', () => {
    expect(previewNextRun('nope')).toBeNull();
  });
});

describe('options', () => {
  it('finds pause lengths by id and rejects unknown ones', () => {
    expect(pauseOption('1h')?.ms).toBe(60 * 60 * 1000);
    expect(pauseOption('restart')?.ms).toBeNull();
    expect(pauseOption('forever')).toBeNull();
  });

  it('knows the CLI effort levels', () => {
    expect(isEffortLevel('xhigh')).toBe(true);
    expect(isEffortLevel('extreme')).toBe(false);
  });
});
