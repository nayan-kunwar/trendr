import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GitHubStargazerCountSchema, GitHubStargazerHistorySchema } from './schemas.js';
import { cumulativeStarHistory, dailyStarCounts, stargazerCoverageStart } from './stars.js';

/**
 * ADR 0012 — the day maths behind the stargazer backfill, plus the recorded
 * `stargazers/history`/`count` fixtures parsed through the schemas the adapter
 * validates with at runtime.
 */

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const DAY = 86_400_000;

describe('stargazer history maths (ADR 0012)', () => {
  it('splits weekly buckets into UTC day counts (Sunday first)', () => {
    // 1792281600 = 2026-10-18T00:00:00Z, a Sunday.
    const counts = dailyStarCounts([{ week: 1792281600, total: 2, days: [1, 1, 0, 0, 0, 0, 0] }]);

    expect([...counts.entries()]).toEqual([
      ['2026-10-18', 1],
      ['2026-10-19', 1],
      ['2026-10-20', 0],
      ['2026-10-21', 0],
      ['2026-10-22', 0],
      ['2026-10-23', 0],
      ['2026-10-24', 0],
    ]);
    const weeks = [{ week: 1792281600, total: 2, days: [1, 1, 0, 0, 0, 0, 0] }];
    expect(stargazerCoverageStart(weeks)?.toISOString()).toBe('2026-10-18T00:00:00.000Z');
    expect(stargazerCoverageStart([])).toBeNull();
  });

  it('emits up to yesterday and counts today as partial', () => {
    const counts = new Map([
      ['2026-10-17', 2],
      ['2026-10-18', 1],
      ['2026-10-19', 1], // today, still partial — read in the same run as the total
    ]);
    const now = new Date('2026-10-19T12:00:00Z');
    const rows = cumulativeStarHistory(
      counts,
      10,
      new Date('2026-10-18T12:00:00Z'),
      now,
      new Date('2026-10-16T00:00:00Z'),
    );

    // The cutoff day is 2026-10-18; 10 now minus today's 1 star.
    expect(rows).toEqual([{ day: '2026-10-18', value: 9 }]);
  });

  it('truncates to the coverage start when the pages stop early (honest truncation)', () => {
    const counts = new Map([
      ['2026-10-17', 2],
      ['2026-10-18', 1],
      ['2026-10-19', 0],
    ]);
    const rows = cumulativeStarHistory(
      counts,
      10,
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-10-19T12:00:00Z'),
      new Date('2026-10-17T00:00:00Z'),
    );

    expect(rows).toEqual([
      { day: '2026-10-17', value: 9 }, // 10 − 1 star on the 18th
      { day: '2026-10-18', value: 10 }, // 10 − 0 stars today
    ]);
  });

  it('returns an empty series for zero stars or an empty window', () => {
    expect(
      cumulativeStarHistory(
        new Map(),
        0,
        new Date('2026-10-01T00:00:00Z'),
        new Date('2026-10-19T12:00:00Z'),
        new Date('2026-10-01T00:00:00Z'),
      ),
    ).toEqual([]);
    expect(
      cumulativeStarHistory(
        new Map(),
        5,
        new Date('2026-10-20T00:00:00Z'), // cutoff after yesterday
        new Date('2026-10-19T12:00:00Z'),
        new Date('2026-10-01T00:00:00Z'),
      ),
    ).toEqual([]);
  });

  it('recorded fixtures satisfy the contract the maths depends on', () => {
    const weeks = GitHubStargazerHistorySchema.parse(fixture('stargazers-history.json'));
    expect(weeks.length).toBeGreaterThanOrEqual(20);

    for (const week of weeks) {
      // Sunday 00:00 UTC buckets with the day counts adding up to the total —
      // the mapping `dailyStarCounts` applies is only valid while these hold.
      expect(week.week % (DAY / 1_000)).toBe(0);
      expect(new Date(week.week * 1_000).getUTCDay()).toBe(0);
      expect(week.days).toHaveLength(7);
      expect(week.days.reduce((sum, day) => sum + day, 0)).toBe(week.total);
    }
    for (let index = 1; index < weeks.length; index += 1) {
      const newer = weeks[index - 1];
      const older = weeks[index];
      if (newer === undefined || older === undefined) throw new Error('fixture gap');
      expect(newer.week - older.week).toBe(7 * 86_400);
    }

    const count = GitHubStargazerCountSchema.parse(fixture('stargazers-count.json'));
    expect(count.count).toBeGreaterThan(0);
  });
});
