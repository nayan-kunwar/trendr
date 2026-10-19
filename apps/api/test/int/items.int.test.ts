import { eq, inArray, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisKeys } from '@trendr/core';
import {
  createDb,
  ingestionRuns,
  insertScores,
  itemAliases,
  itemTopics,
  items,
  scoreRunsCurrent,
  scores,
  snapshots,
  startRun,
  swapCurrentRun,
  topics,
  upsertDailyMetrics,
  upsertItems,
  upsertSnapshots,
  type Connection,
  type Db,
  type ItemUpsert,
  type ScoreUpsert,
  type SnapshotUpsert,
} from '@trendr/db';

import { buildApp } from '../../src/app.js';
import { CACHE_CONTROL } from '../../src/plugins/etag.js';
import {
  ItemAliasesResponse,
  ItemDetailResponse,
  ScoreExplainResponse,
  type HistoryBody,
  type ScoreExplainBody,
  type ScoresBody,
} from '../../src/schemas/items.js';

/**
 * Task 3.3 acceptance (spec §10.1, §10.4): detail, lookup (302), history
 * (hour/day with the 14 d hour limit), score history (hour/day with the 48 h
 * hour limit and the retention-bounded day window), score-explain (eligible +
 * not_eligible) and aliases, over real Postgres + Redis — plus 404
 * problem+json for every route.
 */

const PREFIX = 'int-items';
const TOPIC = 'int-items-topic';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = new Date();

/** Midnight-anchored day `days` before today (hour 12 avoids same-day edges). */
function utcDaysAgo(days: number, hour = 12): Date {
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() - days, hour));
}

const D4 = utcDaysAgo(4, 12);
const D1_EARLY = utcDaysAgo(1, 8);
const D1_LATE = utcDaysAgo(1, 20);
const H1 = new Date(NOW.getTime() - 90 * 60_000);
const H2 = new Date(NOW.getTime() - 30 * 60_000);
const H3 = new Date(NOW.getTime() - 3 * HOUR_MS);
const H2_HOUR = new Date(NOW.getTime() - 2 * HOUR_MS);
const H1_HOUR = new Date(NOW.getTime() - HOUR_MS);

let connection: Connection;
let db: Db;
let redis: Redis;

let runD4 = 0n;
let runD1a = 0n;
let runD1b = 0n;
let runH1 = 0n;
let runH2 = 0n;

const ids = new Map<string, bigint>();

function idOf(key: string): bigint {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`missing fixture ${key}`);
  return id;
}

function itemFixture(externalId: string, overrides: Partial<ItemUpsert> = {}): ItemUpsert {
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: externalId,
    description: `${externalId} description`,
    url: `https://example.test/int/${externalId}`,
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: PREFIX,
    primaryMetric: 'stars',
    upstreamCreatedAt: new Date(NOW.getTime() - 300 * DAY_MS),
    isArchived: false,
    metadata: { suite: PREFIX },
    ...overrides,
  };
}

function snap(externalId: string, capturedAt: Date, value: number): SnapshotUpsert {
  return { itemId: idOf(externalId), metric: 'stars', capturedAt, observedAt: capturedAt, value };
}

function scoreRow(
  externalId: string,
  runId: bigint,
  finalScore: number,
  computedAt: Date,
  overrides: Partial<ScoreUpsert> = {},
): ScoreUpsert {
  return {
    itemId: idOf(externalId),
    window: '24h',
    runId,
    source: 'github',
    computedAt,
    delta: 0,
    base: 0,
    relGrowth: 0,
    rawScore: 0,
    ageFactor: 1,
    confidence: 1,
    anomalyPenalty: 1,
    finalScore,
    zScore: 0,
    percentile: 0,
    rankSource: 1,
    rankAll: null,
    flags: [],
    ...overrides,
  };
}

/** Keys this file's routes write; reset before and after (`item:`/`hist:` only, spec §9.1). */
async function clearItemCaches(): Promise<void> {
  const keys = [...(await redis.keys('item:*')), ...(await redis.keys('hist:*'))];
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL ?? '';
  if (databaseUrl === undefined || redisUrl === '') {
    throw new Error('DATABASE_URL/REDIS_URL are missing — run through `pnpm test:int`');
  }
  connection = createDb(databaseUrl);
  db = connection.db;
  redis = new Redis(redisUrl);

  runD4 = await startRun(db, { source: 'github', jobType: 'score', jobId: `${PREFIX}-run-d4` });
  runD1a = await startRun(db, { source: 'github', jobType: 'score', jobId: `${PREFIX}-run-d1a` });
  runD1b = await startRun(db, { source: 'github', jobType: 'score', jobId: `${PREFIX}-run-d1b` });
  runH1 = await startRun(db, { source: 'github', jobType: 'score', jobId: `${PREFIX}-run-h1` });
  runH2 = await startRun(db, { source: 'github', jobType: 'score', jobId: `${PREFIX}-run-h2` });
  const runIds = [runD4, runD1a, runD1b, runH1, runH2];

  // Idempotent re-runs: same job ids, same run ids — clear their rows, then
  // pin deterministic start times (the day grouping reads started_at).
  await db.delete(scores).where(inArray(scores.runId, runIds));
  await db.delete(scoreRunsCurrent).where(inArray(scoreRunsCurrent.runId, runIds));
  await db.update(ingestionRuns).set({ startedAt: D4 }).where(eq(ingestionRuns.id, runD4));
  await db.update(ingestionRuns).set({ startedAt: D1_EARLY }).where(eq(ingestionRuns.id, runD1a));
  await db.update(ingestionRuns).set({ startedAt: D1_LATE }).where(eq(ingestionRuns.id, runD1b));
  await db.update(ingestionRuns).set({ startedAt: H1 }).where(eq(ingestionRuns.id, runH1));
  await db.update(ingestionRuns).set({ startedAt: H2 }).where(eq(ingestionRuns.id, runH2));

  const upserted = await upsertItems(db, [
    itemFixture(`${PREFIX}-a`),
    itemFixture(`${PREFIX}-b`, {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: null,
    }),
    itemFixture(`${PREFIX}-c`),
    itemFixture(`${PREFIX}-paper`, { source: 'arxiv', kind: 'paper', primaryMetric: 'upvotes' }),
    itemFixture(`${PREFIX}-deleted`),
  ]);
  for (const row of upserted) ids.set(row.externalId, row.id);
  await db
    .update(items)
    .set({ isDeleted: true })
    .where(eq(items.id, idOf(`${PREFIX}-deleted`)));

  const [existingTopic] = await db.select().from(topics).where(eq(topics.slug, TOPIC));
  if (existingTopic === undefined) {
    await db.insert(topics).values({ slug: TOPIC, name: 'Int Items Topic' });
  }
  const [topicRow] = await db.select().from(topics).where(eq(topics.slug, TOPIC));
  if (topicRow === undefined) throw new Error('topic insert returned no row');
  await db
    .insert(itemTopics)
    .values({ itemId: idOf(`${PREFIX}-a`), topicId: topicRow.id })
    .onConflictDoNothing();

  // A: three daily levels, then three hourly samples (day-3/day-2 assertions
  // stay stable regardless of the wall clock).
  await upsertSnapshots(db, [
    snap(`${PREFIX}-a`, utcDaysAgo(3), 80),
    snap(`${PREFIX}-a`, utcDaysAgo(2), 90),
    snap(`${PREFIX}-a`, utcDaysAgo(1), 100),
    snap(`${PREFIX}-a`, H3, 104),
    snap(`${PREFIX}-a`, H2_HOUR, 107),
    snap(`${PREFIX}-a`, H1_HOUR, 110),
  ]);
  await upsertDailyMetrics(db, [
    {
      itemId: idOf(`${PREFIX}-b`),
      metric: 'downloads',
      day: utcDaysAgo(3).toISOString().slice(0, 10),
      value: 1000,
    },
    {
      itemId: idOf(`${PREFIX}-b`),
      metric: 'downloads',
      day: utcDaysAgo(2).toISOString().slice(0, 10),
      value: 1100,
    },
    {
      itemId: idOf(`${PREFIX}-b`),
      metric: 'downloads',
      day: utcDaysAgo(1).toISOString().slice(0, 10),
      value: 1200,
    },
  ]);

  await db.insert(itemAliases).values([
    {
      itemId: idOf(`${PREFIX}-a`),
      aliasItemId: idOf(`${PREFIX}-b`),
      relation: 'package_of',
      confidence: 0.9,
      evidence: PREFIX,
    },
    {
      itemId: idOf(`${PREFIX}-paper`),
      aliasItemId: idOf(`${PREFIX}-a`),
      relation: 'paper_code',
      confidence: 0.8,
      evidence: PREFIX,
    },
  ]);

  await insertScores(db, [
    scoreRow(`${PREFIX}-a`, runD4, 9, D4, { delta: 90, zScore: 1, percentile: 50, rankSource: 4 }),
    scoreRow(`${PREFIX}-a`, runD1a, 1, D1_EARLY, { rankSource: 3 }),
    scoreRow(`${PREFIX}-a`, runD1b, 2, D1_LATE, { rankSource: 2 }),
    scoreRow(`${PREFIX}-a`, runH1, 5, H1, { rankSource: 1 }),
    scoreRow(`${PREFIX}-a`, runH2, 6, H2, {
      delta: 42,
      base: 100,
      relGrowth: 0.2956,
      rawScore: 1.2,
      ageFactor: 0.9,
      confidence: 0.8,
      anomalyPenalty: 1,
      zScore: 2.1,
      percentile: 97,
      rankSource: 1,
      rankAll: 2,
      flags: ['new_item'],
    }),
    scoreRow(`${PREFIX}-a`, runH2, 7.5, H2, {
      window: '7d',
      delta: 10,
      zScore: 1.5,
      percentile: 80,
      rankSource: 2,
      rankAll: 3,
    }),
  ]);

  // Only this file's current runs; stale pointers from an earlier int file
  // would leak into the item-detail `scores` map.
  await db.delete(scoreRunsCurrent);
  await swapCurrentRun(db, { source: 'github', window: '24h', runId: runH2, computedAt: H2 });
  await swapCurrentRun(db, { source: 'github', window: '7d', runId: runH2, computedAt: H2 });

  await clearItemCaches();
});

afterAll(async () => {
  const runIds = [runD4, runD1a, runD1b, runH1, runH2];
  await db.delete(scores).where(inArray(scores.runId, runIds));
  await db.delete(scoreRunsCurrent).where(inArray(scoreRunsCurrent.runId, runIds));
  await db.delete(snapshots).where(inArray(snapshots.itemId, [...ids.values()]));
  await db.delete(items).where(like(items.externalId, `${PREFIX}-%`));
  await db.delete(topics).where(eq(topics.slug, TOPIC));
  await db.delete(ingestionRuns).where(inArray(ingestionRuns.id, runIds));
  await clearItemCaches();
  await redis.quit();
  await connection.pool.end();
});

async function withApp(
  run: (app: FastifyInstance) => Promise<void>,
  retention?: { hourlyHours: number; dailyDays: number },
): Promise<void> {
  const app = await buildApp({
    corsOrigins: ['http://localhost:3000'],
    rateLimit: false,
    db: connection,
    redis,
    ...(retention === undefined ? {} : { scoresRetention: retention }),
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const get = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

function assertProblem(
  response: { statusCode: number; headers: Record<string, unknown>; json: () => unknown },
  status: number,
): void {
  expect(response.statusCode).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
}

describe('item endpoints over real Postgres + Redis (task 3.3)', () => {
  it('serves the item detail with topics, aliases, scores and ETag/304 (spec §10.1, §10.4)', async () => {
    await withApp(async (app) => {
      const response = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}`);
      expect(response.statusCode).toBe(200);
      const body = ItemDetailResponse.parse(response.json());
      expect(body).toMatchObject({
        id: String(idOf(`${PREFIX}-a`)),
        source: 'github',
        kind: 'repo',
        externalId: `${PREFIX}-a`,
        displayName: `${PREFIX}-a`,
        language: 'TypeScript',
        topics: [TOPIC],
        primaryMetric: 'stars',
        latestMetrics: { stars: 110 },
        tier: 'cold',
        metadata: { suite: PREFIX },
      });
      expect(body.upstreamCreatedAt).not.toBeNull();
      expect(body.firstSeenAt).toBeTypeOf('string');
      expect(body.scores['24h']).toMatchObject({
        finalScore: 6,
        zScore: 2.1,
        percentile: 97,
        rankSource: 1,
        rankAll: 2,
        delta: 42,
        flags: ['new_item'],
      });
      expect(body.scores['7d']).toMatchObject({ finalScore: 7.5, rankSource: 2 });
      expect(body.scores['30d']).toBeNull();
      // Detail aliases are the item's own (outgoing) rows only.
      expect(body.aliases).toEqual([
        {
          id: String(idOf(`${PREFIX}-b`)),
          source: 'npm',
          displayName: `${PREFIX}-b`,
          relation: 'package_of',
          confidence: 0.9,
        },
      ]);

      expect(response.headers['cache-control']).toBe(CACHE_CONTROL.publicLong);
      const etag = response.headers.etag;
      expect(etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
      expect(await redis.exists(redisKeys.item(idOf(`${PREFIX}-a`)))).toBe(1);

      const cached = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}`, {
        'if-none-match': etag ?? '',
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe('');
      expect(cached.headers.etag).toBe(etag);
    });
  });

  it('404s unknown, deleted and malformed item ids (spec §10.1)', async () => {
    await withApp(async (app) => {
      const missing = await get(app, '/v1/items/999999999');
      assertProblem(missing, 404);
      expect(missing.json()).toMatchObject({
        type: 'https://trendr.dev/problems/not-found',
        status: 404,
      });

      const deleted = await get(app, `/v1/items/${idOf(`${PREFIX}-deleted`)}`);
      assertProblem(deleted, 404);

      const malformed = await get(app, '/v1/items/not-a-number');
      assertProblem(malformed, 400);
    });
  });

  it('302s a natural-key lookup to the item URL and 404s misses (spec §10.1)', async () => {
    await withApp(async (app) => {
      const found = await get(app, `/v1/items/lookup?source=github&externalId=${PREFIX}-a`);
      expect(found.statusCode).toBe(302);
      expect(found.headers.location).toBe(`/v1/items/${idOf(`${PREFIX}-a`)}`);

      const wrongSource = await get(app, `/v1/items/lookup?source=npm&externalId=${PREFIX}-a`);
      assertProblem(wrongSource, 404);

      const missing = await get(app, '/v1/items/lookup?source=github&externalId=does-not-exist');
      assertProblem(missing, 404);

      const deleted = await get(app, `/v1/items/lookup?source=github&externalId=${PREFIX}-deleted`);
      assertProblem(deleted, 404);
    });
  });

  it('serves hour and day metric history, and rejects an hour range beyond 14 d (spec §10.1, §10.4)', async () => {
    await withApp(async (app) => {
      const hourFrom = new Date(NOW.getTime() - 6 * HOUR_MS).toISOString();
      const hour = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-a`)}/history?granularity=hour&from=${encodeURIComponent(hourFrom)}`,
      );
      expect(hour.statusCode).toBe(200);
      const hourBody = hour.json<HistoryBody>();
      expect(hourBody).toMatchObject({
        itemId: String(idOf(`${PREFIX}-a`)),
        metric: 'stars',
        kind: 'cumulative',
        granularity: 'hour',
      });
      expect(hourBody.points).toEqual([
        { t: H3.toISOString(), v: 104 },
        { t: H2_HOUR.toISOString(), v: 107 },
        { t: H1_HOUR.toISOString(), v: 110 },
      ]);

      const day = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-a`)}/history?from=${encodeURIComponent(utcDaysAgo(10).toISOString())}`,
      );
      const dayBody = day.json<HistoryBody>();
      expect(dayBody.granularity).toBe('day');
      const byDay = new Map(dayBody.points.map((point) => [point.t, point.v]));
      expect(byDay.get(utcDaysAgo(3).toISOString().slice(0, 10))).toBe(80);
      expect(byDay.get(utcDaysAgo(2).toISOString().slice(0, 10))).toBe(90);
      expect([...byDay.keys()]).toEqual([...byDay.keys()].sort());

      // Daily-count metrics come from daily_metrics; they have no hourly series.
      const downloads = await get(app, `/v1/items/${idOf(`${PREFIX}-b`)}/history`);
      const downloadsBody = downloads.json<HistoryBody>();
      expect(downloadsBody).toMatchObject({ metric: 'downloads', kind: 'daily_count' });
      expect(downloadsBody.points).toEqual([
        { t: utcDaysAgo(3).toISOString().slice(0, 10), v: 1000 },
        { t: utcDaysAgo(2).toISOString().slice(0, 10), v: 1100 },
        { t: utcDaysAgo(1).toISOString().slice(0, 10), v: 1200 },
      ]);
      const downloadsHour = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-b`)}/history?granularity=hour`,
      );
      expect(downloadsHour.json<HistoryBody>().points).toEqual([]);

      // §10.4: hour granularity is limited to the last 14 days.
      const tooOld = new Date(NOW.getTime() - 15 * DAY_MS).toISOString();
      const rejected = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-a`)}/history?granularity=hour&from=${encodeURIComponent(tooOld)}`,
      );
      assertProblem(rejected, 400);
      expect(rejected.json()).toMatchObject({
        type: 'https://trendr.dev/problems/validation-error',
        status: 400,
      });

      const missing = await get(app, '/v1/items/999999999/history');
      assertProblem(missing, 404);
      expect((await redis.keys('hist:*')).length).toBeGreaterThan(0);
    });
  });

  it('serves hourly score history and the last run per UTC day (spec §10.1)', async () => {
    await withApp(async (app) => {
      const hour = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-a`)}/scores?window=24h&granularity=hour&days=2`,
      );
      expect(hour.statusCode).toBe(200);
      const hourBody = hour.json<ScoresBody>();
      expect(hourBody.points.map((point) => [point.runId, point.finalScore])).toEqual([
        [String(runD1a), 1],
        [String(runD1b), 2],
        [String(runH1), 5],
        [String(runH2), 6],
      ]);

      const day = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}/scores?window=24h`);
      const dayBody = day.json<ScoresBody>();
      expect(dayBody.granularity).toBe('day');
      // One point per UTC day: day-4's single run survives unchanged, and the
      // last run overall is runH2. Ineligible days would simply be absent.
      const dates = dayBody.points.map((point) => point.t.slice(0, 10));
      expect(new Set(dates).size).toBe(dates.length);
      expect([...dates]).toEqual([...dates].sort());
      const byRun = new Map(dayBody.points.map((point) => [point.runId, point.finalScore]));
      expect(byRun.get(String(runD4))).toBe(9);
      expect(dayBody.points.at(-1)?.runId).toBe(String(runH2));
      expect(dayBody.points.at(-1)?.finalScore).toBe(6);
    });
  });

  it('caps day history at the configured daily retention (spec §10.4)', async () => {
    await withApp(
      async (app) => {
        const day = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}/scores?window=24h&days=180`);
        expect(day.statusCode).toBe(200);
        const values = day.json<ScoresBody>().points.map((point) => point.finalScore);
        expect(values).not.toContain(9); // runD4 is ~4 days old; daily retention is 3 days
        expect(values).toContain(6);
      },
      { hourlyHours: 48, dailyDays: 3 },
    );
  });

  it('rejects hour granularity beyond 48 h and 404s unknown items (spec §10.4)', async () => {
    await withApp(async (app) => {
      const rejected = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-a`)}/scores?granularity=hour&days=3`,
      );
      assertProblem(rejected, 400);
      expect(rejected.json()).toMatchObject({ status: 400, title: 'Bad Request' });

      const missing = await get(app, '/v1/items/999999999/scores');
      assertProblem(missing, 404);
    });
  });

  it('explains the current score with components, params and inputs (spec §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}/score-explain?window=24h`);
      expect(response.statusCode).toBe(200);
      const body = ScoreExplainResponse.parse(response.json());
      expect(body).toMatchObject({
        itemId: String(idOf(`${PREFIX}-a`)),
        source: 'github',
        window: '24h',
        runId: String(runH2),
        computedAt: H2.toISOString(),
        components: {
          delta: 42,
          base: 100,
          relGrowth: 0.2956,
          rawScore: 1.2,
          ageFactor: 0.9,
          confidence: 0.8,
          anomalyPenalty: 1,
          finalScore: 6,
        },
        params: { k: 100, minDelta: 10, beta: 0.35, rMax: 50, burstMinAbs: 300 },
        inputs: {
          delta: 42,
          base: 100,
          anomalyPenalty: 1,
          zScore: 2.1,
          percentile: 97,
          rankSource: 1,
          rankAll: 2,
          flags: ['new_item'],
        },
      });
      expect(body.reason).toBeUndefined();
      expect(response.headers['cache-control']).toBe(CACHE_CONTROL.publicLong);

      // A current run exists but the item was not eligible in it.
      const ineligible = await get(
        app,
        `/v1/items/${idOf(`${PREFIX}-c`)}/score-explain?window=24h`,
      );
      const ineligibleBody = ineligible.json<ScoreExplainBody>();
      expect(ineligibleBody).toMatchObject({
        runId: String(runH2),
        components: null,
        inputs: null,
        reason: 'not_eligible',
      });
      expect(ineligibleBody.params).not.toBeNull();

      // No current run at all for this window.
      const noRun = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}/score-explain?window=30d`);
      expect(noRun.json<ScoreExplainBody>()).toMatchObject({
        runId: null,
        computedAt: null,
        components: null,
        reason: 'not_eligible',
      });

      const missing = await get(app, '/v1/items/999999999/score-explain');
      assertProblem(missing, 404);
    });
  });

  it('lists alias links in both directions with their relation (spec §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, `/v1/items/${idOf(`${PREFIX}-a`)}/aliases`);
      expect(response.statusCode).toBe(200);
      const body = ItemAliasesResponse.parse(response.json());
      expect(body.itemId).toBe(String(idOf(`${PREFIX}-a`)));
      expect(body.aliases).toEqual([
        {
          id: String(idOf(`${PREFIX}-b`)),
          source: 'npm',
          kind: 'package',
          externalId: `${PREFIX}-b`,
          displayName: `${PREFIX}-b`,
          url: `https://example.test/int/${PREFIX}-b`,
          relation: 'package_of',
          confidence: 0.9,
          evidence: PREFIX,
          direction: 'outgoing',
        },
        {
          id: String(idOf(`${PREFIX}-paper`)),
          source: 'arxiv',
          kind: 'paper',
          externalId: `${PREFIX}-paper`,
          displayName: `${PREFIX}-paper`,
          url: `https://example.test/int/${PREFIX}-paper`,
          relation: 'paper_code',
          confidence: 0.8,
          evidence: PREFIX,
          direction: 'incoming',
        },
      ]);

      const missing = await get(app, '/v1/items/999999999/aliases');
      assertProblem(missing, 404);
    });
  });
});
