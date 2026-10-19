import { describe, expect, it } from 'vitest';

import { lastRunPerUtcDay, type ScoreHistoryRow } from './scores.repo.js';

/** Spec §10.1/§10.4 — day-granularity score history keeps one point per UTC day. */

function row(runId: number, startedAt: string, finalScore: number): ScoreHistoryRow {
  return {
    runId: BigInt(runId),
    startedAt: new Date(startedAt),
    computedAt: new Date(startedAt),
    finalScore,
    zScore: 0,
    percentile: 0,
    rankSource: 1,
    delta: 0,
  };
}

describe('lastRunPerUtcDay (spec §10.4 score history)', () => {
  it('keeps the last run of each UTC day, oldest day first', () => {
    const rows = [
      row(1, '2026-06-01T08:00:00Z', 1),
      row(2, '2026-06-01T20:00:00Z', 2),
      row(3, '2026-06-02T06:00:00Z', 3),
    ];
    const picked = lastRunPerUtcDay(rows);
    expect(picked.map((r) => [r.startedAt.toISOString(), r.finalScore])).toEqual([
      ['2026-06-01T20:00:00.000Z', 2],
      ['2026-06-02T06:00:00.000Z', 3],
    ]);
  });

  it('groups by UTC day, not local time', () => {
    const rows = [row(1, '2026-06-01T23:30:00Z', 1), row(2, '2026-06-02T00:30:00Z', 2)];
    expect(lastRunPerUtcDay(rows)).toHaveLength(2);
  });

  it('is a gap when a day has no run, and ties prefer the later run id', () => {
    const rows = [
      row(1, '2026-06-01T10:00:00Z', 1),
      row(2, '2026-06-01T10:00:00Z', 2),
      row(3, '2026-06-04T10:00:00Z', 3),
    ];
    const picked = lastRunPerUtcDay(rows);
    expect(picked.map((r) => r.runId)).toEqual([2n, 3n]);
  });

  it('returns an empty list unchanged', () => {
    expect(lastRunPerUtcDay([])).toEqual([]);
  });
});
