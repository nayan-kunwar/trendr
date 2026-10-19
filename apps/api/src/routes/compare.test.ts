import { describe, expect, it } from 'vitest';

import { NotFoundError, ValidationError } from '@trendr/core';

import { CompareQuery } from '../schemas/compare.js';
import { parseCompareIds, resolveCompareGranularity } from './compare.js';

/** Spec §10.1 — `/v1/compare` id parsing and the granularity default. */

const MAX_ID = '9223372036854775807';

describe('parseCompareIds (spec §10.1)', () => {
  it('parses 2–5 comma-separated ids, trimming whitespace', () => {
    expect(parseCompareIds('1, 2,3')).toEqual([1n, 2n, 3n]);
    expect(parseCompareIds(`${MAX_ID},1`)).toEqual([9_223_372_036_854_775_807n, 1n]);
  });

  it('rejects fewer than 2 or more than 5 ids', () => {
    expect(() => parseCompareIds('1')).toThrow(ValidationError);
    expect(() => parseCompareIds('1,2,3,4,5,6')).toThrow(ValidationError);
  });

  it('rejects malformed and duplicate ids', () => {
    expect(() => parseCompareIds('1,abc')).toThrow(ValidationError);
    expect(() => parseCompareIds('1,')).toThrow(ValidationError);
    expect(() => parseCompareIds('-1,2')).toThrow(ValidationError);
    expect(() => parseCompareIds('1,1')).toThrow(ValidationError);
  });

  it('treats ids beyond the bigint range as not found', () => {
    expect(() => parseCompareIds('1,9223372036854775808')).toThrow(NotFoundError);
  });
});

describe('resolveCompareGranularity (spec §10.1)', () => {
  it('defaults to hour for 24h/7d and day for 30d', () => {
    expect(resolveCompareGranularity(CompareQuery.parse({ ids: '1,2' }))).toBe('hour');
    expect(resolveCompareGranularity(CompareQuery.parse({ ids: '1,2', window: '7d' }))).toBe(
      'hour',
    );
    expect(resolveCompareGranularity(CompareQuery.parse({ ids: '1,2', window: '30d' }))).toBe(
      'day',
    );
  });

  it('honours an explicit granularity', () => {
    expect(
      resolveCompareGranularity(
        CompareQuery.parse({ ids: '1,2', window: '24h', granularity: 'day' }),
      ),
    ).toBe('day');
  });
});
