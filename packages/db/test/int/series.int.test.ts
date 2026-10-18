import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { paramsFor, toDailyVelocityInput, toVelocityInput, type Metric } from '@trendr/core';

import { createDb, type Connection, type Db } from '../../src/client.js';
import { type ItemUpsert, upsertItems } from '../../src/repositories/items.repo.js';
import {
  loadCumulativeSeries,
  loadDailyFallback,
  loadDailySeries,
  loadHourlySeries,
  type LoadedCumulativeSeries,
  type LoadedDailySeries,
} from '../../src/repositories/series.repo.js';
import {
  type SnapshotUpsert,
  upsertDailyMetrics,
  upsertSnapshots,
} from '../../src/repositories/snapshots.repo.js';
import { items } from '../../src/schema/items.js';

/**
 * Task 2.3 acceptance: the §8.6 endpoint query, the `daily_metrics` fallback
 * pass and the daily-count aggregate, exercised against real rows. Each case
 * is converted through `toVelocityInput` / `toDailyVelocityInput` so the test
 * pins the expected Δ, B and c, not just the raw columns: normal brackets,
 * tracked-late, truly new, stale tiers, the 36 h outer bound, archived /
 * deleted / hidden exclusions, the fallback day, daily gaps, the 24 h mean vs
 * the 7 d / 30 d previous sums, and the burst-pass hourly increments.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WINDOW = 7 * DAY;

/** Scoring instant: noon UTC of the current day, so tests never race the clock. */
const now = new Date();
const T = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
const tW = T.getTime() - WINDOW;

function ago(ms: number): Date {
  return new Date(T.getTime() - ms);
}

function atWindowMinus(ms: number): Date {
  return new Date(tW - ms);
}

function atWindowPlus(ms: number): Date {
  return new Date(tW + ms);
}

/** `'YYYY-MM-DD'` of the UTC day `daysBefore` days before `T`'s day. */
function day(daysBefore: number): string {
  const startOfDay = Date.UTC(T.getUTCFullYear(), T.getUTCMonth(), T.getUTCDate());
  return new Date(startOfDay - daysBefore * DAY).toISOString().slice(0, 10);
}

let connection: Connection;
let db: Db;
const ids = new Map<string, bigint>();

function idOf(externalId: string): bigint {
  const id = ids.get(externalId);
  if (id === undefined) throw new Error(`missing fixture ${externalId}`);
  return id;
}

function fixture(externalId: string, overrides: Partial<ItemUpsert> = {}): ItemUpsert {
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: externalId,
    description: null,
    url: `https://example.test/series/${externalId}`,
    homepage: null,
    language: null,
    license: null,
    owner: 'series',
    primaryMetric: 'stars',
    upstreamCreatedAt: ago(365 * DAY),
    isArchived: false,
    metadata: {},
    ...overrides,
  };
}

function snap(externalId: string, metric: Metric, capturedAt: Date, value: number): SnapshotUpsert {
  return { itemId: idOf(externalId), metric, capturedAt, observedAt: capturedAt, value };
}

function cumulativeRow(rows: LoadedCumulativeSeries[], externalId: string): LoadedCumulativeSeries {
  const target = idOf(externalId);
  const row = rows.find((candidate) => candidate.itemId === target);
  if (!row) throw new Error(`no cumulative row for ${externalId}`);
  return row;
}

function dailyRow(rows: LoadedDailySeries[], externalId: string): LoadedDailySeries {
  const target = idOf(externalId);
  const row = rows.find((candidate) => candidate.itemId === target);
  if (!row) throw new Error(`no daily row for ${externalId}`);
  return row;
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
  connection = createDb(databaseUrl);
  db = connection.db;

  const upserted = await upsertItems(db, [
    // A: both brackets present, 2 h either side of t−W (τ_7d = 16.8 h).
    fixture('series-interp'),
    // B: no data near t−W, first observation 3 d into the window.
    fixture('series-late'),
    // C: created inside the window.
    fixture('series-new', { upstreamCreatedAt: ago(5 * DAY) }),
    // D1: hot tier that has gone stale (5 h > 3 h) but is inside the 36 h bound.
    fixture('series-stale-hot'),
    // D2: newest snapshot 40 h back — outside the §8.6 outer bound, not returned.
    fixture('series-too-old'),
    // Exclusions: archived tier, soft-deleted, manual_hidden.
    fixture('series-archived'),
    fixture('series-deleted'),
    fixture('series-hidden', { flags: ['manual_hidden'] }),
    // J: cumulative primary with no brackets — the daily_metrics fallback pass.
    fixture('series-fallback', { source: 'huggingface', kind: 'model', primaryMetric: 'likes' }),
    // Burst pass source for loadHourlySeries.
    fixture('series-hourly'),
    // Daily-count fixtures (npm downloads).
    fixture('series-daily-gap', {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: 'javascript',
    }),
    fixture('series-daily-stale', {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: 'javascript',
    }),
    fixture('series-daily-24h', {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: 'javascript',
    }),
    fixture('series-daily-30d', {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: 'javascript',
    }),
    fixture('series-daily-archived', {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: 'javascript',
    }),
    fixture('series-daily-hidden', {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: 'javascript',
      flags: ['manual_hidden'],
    }),
  ]);
  for (const row of upserted) ids.set(row.externalId, row.id);

  await upsertSnapshots(
    db,
    [
      snap('series-interp', 'stars', atWindowMinus(2 * HOUR), 1000),
      snap('series-interp', 'stars', atWindowPlus(2 * HOUR), 1200),
      snap('series-interp', 'stars', ago(HOUR), 1500),
      snap('series-late', 'stars', ago(3 * DAY), 500),
      snap('series-late', 'stars', ago(HOUR), 700),
      snap('series-new', 'stars', ago(HOUR), 150),
      snap('series-stale-hot', 'stars', atWindowMinus(2 * HOUR), 700),
      snap('series-stale-hot', 'stars', atWindowPlus(2 * HOUR), 800),
      snap('series-stale-hot', 'stars', ago(5 * HOUR), 800),
      snap('series-too-old', 'stars', ago(40 * HOUR), 100),
      snap('series-archived', 'stars', ago(HOUR), 10),
      snap('series-deleted', 'stars', ago(HOUR), 10),
      snap('series-hidden', 'stars', ago(HOUR), 10),
      snap('series-fallback', 'likes', ago(HOUR), 900),
      snap('series-hourly', 'stars', ago(3 * HOUR), 100),
      snap('series-hourly', 'stars', ago(2 * HOUR), 120),
      snap('series-hourly', 'stars', ago(HOUR), 130),
    ],
    { refreshAggregates: false },
  );

  await upsertDailyMetrics(db, [
    // Gap item: D = yesterday; two of the seven S_cur days missing (c = 5/7);
    // today's row must be ignored even though it exists; prev week complete.
    { itemId: idOf('series-daily-gap'), metric: 'downloads', day: day(0), value: 999 },
    { itemId: idOf('series-daily-gap'), metric: 'downloads', day: day(1), value: 50 },
    { itemId: idOf('series-daily-gap'), metric: 'downloads', day: day(2), value: 30 },
    { itemId: idOf('series-daily-gap'), metric: 'downloads', day: day(4), value: 40 },
    { itemId: idOf('series-daily-gap'), metric: 'downloads', day: day(5), value: 20 },
    { itemId: idOf('series-daily-gap'), metric: 'downloads', day: day(7), value: 10 },
    ...[8, 9, 10, 11, 12, 13, 14].map((daysBefore) => ({
      itemId: idOf('series-daily-gap'),
      metric: 'downloads' as const,
      day: day(daysBefore),
      value: 10,
    })),
    // Stale item: D is four days back → expired, c = 0.
    { itemId: idOf('series-daily-stale'), metric: 'downloads', day: day(4), value: 100 },
    // 24h item: S_cur is day D alone; S_prev is the mean of [D−7, D−1].
    { itemId: idOf('series-daily-24h'), metric: 'downloads', day: day(1), value: 100 },
    ...[2, 3, 4, 5, 6, 7, 8].map((daysBefore) => ({
      itemId: idOf('series-daily-24h'),
      metric: 'downloads' as const,
      day: day(daysBefore),
      value: 20,
    })),
    // 30d item: S_cur sums [D−29, D]; S_prev sums [D−59, D−30].
    ...[
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28, 29, 30,
    ].map((daysBefore) => ({
      itemId: idOf('series-daily-30d'),
      metric: 'downloads' as const,
      day: day(daysBefore),
      value: 2,
    })),
    ...[
      31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53,
      54, 55, 56, 57, 58, 59, 60,
    ].map((daysBefore) => ({
      itemId: idOf('series-daily-30d'),
      metric: 'downloads' as const,
      day: day(daysBefore),
      value: 1,
    })),
    { itemId: idOf('series-daily-archived'), metric: 'downloads', day: day(1), value: 5 },
    { itemId: idOf('series-daily-hidden'), metric: 'downloads', day: day(1), value: 5 },
    // Fallback item: end-of-day value for the UTC day before t−W (day 8).
    { itemId: idOf('series-fallback'), metric: 'likes', day: day(8), value: 400 },
  ]);

  await db
    .update(items)
    .set({ tier: 'hot' })
    .where(eq(items.id, idOf('series-stale-hot')));
  await db
    .update(items)
    .set({ tier: 'archived' })
    .where(eq(items.id, idOf('series-archived')));
  await db
    .update(items)
    .set({ isDeleted: true })
    .where(eq(items.id, idOf('series-deleted')));
  await db
    .update(items)
    .set({ tier: 'archived' })
    .where(eq(items.id, idOf('series-daily-archived')));
});

afterAll(async () => {
  await connection.pool.end();
});

describe('loadCumulativeSeries (§8.6)', () => {
  it('interpolates V_then from the brackets around t − W', async () => {
    const rows = await loadCumulativeSeries(db, 'github', T, '7d');
    const row = cumulativeRow(rows, 'series-interp');

    expect(row.vNow).toBe(1500);
    expect(row.tNow.getTime()).toBe(ago(HOUR).getTime());
    expect(row.vBefore).toBe(1000);
    expect(row.vAfter).toBe(1200);

    const conversion = toVelocityInput(row, '7d', T);
    expect(conversion.thenSource).toBe('interpolated');
    expect(conversion.reset).toBe(false);
    expect(conversion.velocity.delta).toBe(400);
    expect(conversion.velocity.base).toBe(1100);
    expect(conversion.velocity.coverage).toBe(1);
    expect(conversion.velocity.stale).toBe(false);
  });

  it('tracks an item late from V_first with c = (t − t_first)/W', async () => {
    const rows = await loadCumulativeSeries(db, 'github', T, '7d');
    const row = cumulativeRow(rows, 'series-late');

    expect(row.vBefore).toBeNull();
    expect(row.vAfter).toBeNull();

    const conversion = toVelocityInput(row, '7d', T);
    expect(conversion.thenSource).toBe('tracked_late');
    expect(conversion.velocity.delta).toBe(200);
    expect(conversion.velocity.base).toBe(500);
    expect(conversion.velocity.coverage).toBeCloseTo(3 / 7, 12);
  });

  it('starts a truly new item from zero with c = 1', async () => {
    const rows = await loadCumulativeSeries(db, 'github', T, '7d');
    const row = cumulativeRow(rows, 'series-new');

    const conversion = toVelocityInput(row, '7d', T);
    expect(conversion.thenSource).toBe('new_item');
    expect(conversion.velocity.delta).toBe(150);
    expect(conversion.velocity.base).toBe(0);
    expect(conversion.velocity.coverage).toBe(1);
  });

  it('applies the tier staleness limit in TypeScript and drops data outside 36 h', async () => {
    const rows = await loadCumulativeSeries(db, 'github', T, '7d');
    const row = cumulativeRow(rows, 'series-stale-hot');

    const conversion = toVelocityInput(row, '7d', T);
    expect(conversion.thenSource).toBe('interpolated');
    expect(conversion.velocity.delta).toBe(50);
    expect(conversion.velocity.base).toBe(750);
    expect(conversion.velocity.coverage).toBe(1);
    expect(conversion.velocity.stale).toBe(true);

    expect(rows.some((candidate) => candidate.itemId === idOf('series-too-old'))).toBe(false);
  });

  it('excludes archived, soft-deleted and manually hidden items', async () => {
    const rows = await loadCumulativeSeries(db, 'github', T, '7d');
    for (const externalId of ['series-archived', 'series-deleted', 'series-hidden']) {
      expect(rows.some((candidate) => candidate.itemId === idOf(externalId))).toBe(false);
    }
  });

  it('falls back to the daily end-of-day value when both brackets are missing', async () => {
    const rows = await loadCumulativeSeries(db, 'huggingface', T, '7d');
    const row = cumulativeRow(rows, 'series-fallback');

    expect(row.vBefore).toBeNull();
    expect(row.vAfter).toBeNull();
    expect(row.dailyFallback).toBeNull();

    const fallback = await loadDailyFallback(db, [row.itemId], T, '7d');
    expect(fallback.get(row.itemId)).toBe(400);

    const conversion = toVelocityInput({ ...row, dailyFallback: 400 }, '7d', T);
    expect(conversion.thenSource).toBe('daily_fallback');
    expect(conversion.velocity.base).toBe(400);
    expect(conversion.velocity.delta).toBe(500);
    expect(conversion.velocity.coverage).toBeCloseTo(HOUR / WINDOW, 12);

    expect(await loadDailyFallback(db, [], T, '7d')).toEqual(new Map());
    const withoutDaily = await loadDailyFallback(db, [idOf('series-interp')], T, '7d');
    expect(withoutDaily.has(idOf('series-interp'))).toBe(false);
  });
});

describe('loadDailySeries (§8.6)', () => {
  it('aggregates daily counts with gaps, excluding the current day', async () => {
    const rows = await loadDailySeries(db, 'npm', T, '7d');
    const row = dailyRow(rows, 'series-daily-gap');

    expect(row.latestDay).toBe(day(1));
    expect(row.sCur).toBe(150);
    expect(row.sPrev).toBe(70);
    expect(row.curDaysPresent).toBe(5);
    expect(row.recentDaily.at(-1)).toBe(50);

    const conversion = toDailyVelocityInput(row, '7d', T, paramsFor('npm', 'downloads', '7d'));
    expect(conversion.expired).toBe(false);
    expect(conversion.velocity.delta).toBe(80);
    expect(conversion.velocity.base).toBe(70);
    expect(conversion.velocity.coverage).toBeCloseTo(5 / 7, 12);
  });

  it('marks data older than D ≥ today − 3 as expired with c = 0', async () => {
    const rows = await loadDailySeries(db, 'npm', T, '7d');
    const row = dailyRow(rows, 'series-daily-stale');

    expect(row.latestDay).toBe(day(4));

    const conversion = toDailyVelocityInput(row, '7d', T, paramsFor('npm', 'downloads', '7d'));
    expect(conversion.expired).toBe(true);
    expect(conversion.velocity.coverage).toBe(0);
  });

  it('uses the 7-day mean as S_prev for 24h data', async () => {
    const rows = await loadDailySeries(db, 'npm', T, '24h');
    const row = dailyRow(rows, 'series-daily-24h');

    expect(row.sCur).toBe(100);
    expect(row.sPrev).toBe(20);
    expect(row.curDaysPresent).toBe(1);

    const conversion = toDailyVelocityInput(row, '24h', T, paramsFor('npm', 'downloads', '24h'));
    expect(conversion.velocity.delta).toBe(80);
    expect(conversion.velocity.base).toBe(20);
    expect(conversion.velocity.coverage).toBe(1);
  });

  it('sums the previous 30-day period for the 30d window', async () => {
    const rows = await loadDailySeries(db, 'npm', T, '30d');
    const row = dailyRow(rows, 'series-daily-30d');

    expect(row.sCur).toBe(60);
    expect(row.sPrev).toBe(30);
    expect(row.curDaysPresent).toBe(30);

    const conversion = toDailyVelocityInput(row, '30d', T, paramsFor('npm', 'downloads', '30d'));
    expect(conversion.velocity.delta).toBe(30);
    expect(conversion.velocity.base).toBe(30);
    expect(conversion.velocity.coverage).toBe(1);
  });

  it('keeps cumulative and daily-count items on their own paths', async () => {
    const daily = await loadDailySeries(db, 'npm', T, '7d');
    for (const externalId of ['series-daily-archived', 'series-daily-hidden']) {
      expect(daily.some((candidate) => candidate.itemId === idOf(externalId))).toBe(false);
    }

    const cumulative = await loadCumulativeSeries(db, 'npm', T, '7d');
    expect(cumulative.some((candidate) => candidate.itemId === idOf('series-daily-gap'))).toBe(
      false,
    );
  });
});

describe('loadHourlySeries (§8.6 burst pass)', () => {
  it('returns hourly values oldest → newest for the requested items', async () => {
    const hourly = await loadHourlySeries(db, [idOf('series-hourly')], T, '7d');
    expect(hourly.get(idOf('series-hourly'))).toEqual([100, 120, 130]);
    expect(await loadHourlySeries(db, [], T, '7d')).toEqual(new Map());
  });
});
