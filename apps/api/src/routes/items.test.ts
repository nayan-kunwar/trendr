import { describe, expect, it } from 'vitest';

import { NotFoundError } from '@trendr/core';

import { historyRangeKey, parseItemId, truncateToGranularity } from './items.js';

/** Spec §9.1 (`hist:` cache key) and §10.1 (`:id` handling). */

describe('truncateToGranularity (spec §9.1)', () => {
  it('floors to the hour or UTC day grid', () => {
    expect(truncateToGranularity(new Date('2026-06-01T13:37:42.500Z'), 'hour').toISOString()).toBe(
      '2026-06-01T13:00:00.000Z',
    );
    expect(truncateToGranularity(new Date('2026-06-01T13:37:42.500Z'), 'day').toISOString()).toBe(
      '2026-06-01T00:00:00.000Z',
    );
  });
});

describe('historyRangeKey (spec §9.1)', () => {
  it('labels the truncated span in hours or days', () => {
    const from = new Date('2026-06-01T10:00:00Z');
    const to = new Date('2026-06-01T22:00:00Z');
    expect(historyRangeKey(from, to, 'hour')).toBe('12h');
    expect(historyRangeKey(from, new Date('2026-07-01T10:00:00Z'), 'day')).toBe('30d');
  });

  it('never labels a zero-length range as 0', () => {
    const t = new Date('2026-06-01T10:00:00Z');
    expect(historyRangeKey(t, t, 'hour')).toBe('1h');
    expect(historyRangeKey(t, t, 'day')).toBe('1d');
  });
});

describe('parseItemId (spec §10.1)', () => {
  it('accepts ids within bigint range and 404s the rest', () => {
    expect(parseItemId('42')).toBe(42n);
    expect(parseItemId('9223372036854775807')).toBe(9223372036854775807n);
    expect(() => parseItemId('9999999999999999999')).toThrow(NotFoundError);
  });
});
