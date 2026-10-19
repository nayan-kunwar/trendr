import { and, eq, inArray, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LeaderboardCardSchema, redisKeys, type Source } from '@trendr/core';
import {
  createDb,
  ingestionRuns,
  insertScores,
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
  type DailyMetricUpsert,
  type Db,
  type ItemUpsert,
  type ScoreUpsert,
  type SnapshotUpsert,
} from '@trendr/db';

import { buildApp } from '../../src/app.js';
import { CACHE_CONTROL } from '../../src/plugins/etag.js';
import { canonicalQuery } from '../../src/routes/trending.js';
import {
  TrendingQuery,
  TrendingResponse,
  type LeaderboardEntry,
  type TrendingResponseBody,
} from '../../src/schemas/trending.js';

/**
 * Task 3.2 acceptance (spec §9.3, §9.4, §10.3, §16) over real Postgres +
 * Redis: the board read (`lbmeta` → ETag/304 → ZSET → cards), hydration of
 * cards that are missing or out of range, run-pinned pagination (410 after a
 * rebuild), the SQL path for topic/kind/lang/minCurrent/newOnly plus its `q:`
 * cache, and page stability while another source is rescored.
 *
 * Boards are seeded directly in Redis (the worker's `publishBoard` contract):
 * `lb:github:24h:_all` with cards for A and B, no card for C (hydrated), and
 * `lb:all:24h:_all` with no cards for C and D. `npm/24h` intentionally has no
 * Redis board so the SQL fallback serves it.
 */

const PREFIX = 'int-trending';
const TOPIC = 'int-test-topic';
const DAY = 86_400_000;
const NOW = new Date();
/** Board/run timestamps: in the past so hydrated series days are complete. */
const COMPUTED_AT = new Date(NOW.getTime() - 3_600_000);
const COMPUTED_AT_2 = new Date(NOW.getTime() - 1_800_000);

/** Midnight-anchored day `days` before today (hour 12 avoids same-day edges). */
function utcDaysAgo(days: number, hour = 12): Date {
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() - days, hour));
}

function dayString(days: number): string {
  return utcDaysAgo(days).toISOString().slice(0, 10);
}

let connection: Connection;
let db: Db;
let redis: Redis;

let githubRun = 0n;
let npmRun = 0n;
let npmRun2 = 0n;
let githubRun2 = 0n;
let topicId = 0;

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
    upstreamCreatedAt: new Date(NOW.getTime() - 300 * DAY),
    isArchived: false,
    metadata: {},
    ...overrides,
  };
}

function snap(externalId: string, capturedAt: Date, value: number): SnapshotUpsert {
  return { itemId: idOf(externalId), metric: 'stars', capturedAt, observedAt: capturedAt, value };
}

function daily(externalId: string, day: string, value: number): DailyMetricUpsert {
  return { itemId: idOf(externalId), metric: 'downloads', day, value };
}

function scoreRow(
  externalId: string,
  source: Source,
  runId: bigint,
  overrides: Partial<ScoreUpsert>,
): ScoreUpsert {
  return {
    itemId: idOf(externalId),
    window: '24h',
    runId,
    source,
    computedAt: COMPUTED_AT,
    delta: 0,
    base: 0,
    relGrowth: 0,
    rawScore: 0,
    ageFactor: 1,
    confidence: 1,
    anomalyPenalty: 1,
    finalScore: 0,
    zScore: 0,
    percentile: 0,
    rankSource: 1,
    rankAll: null,
    flags: [],
    ...overrides,
  };
}

function cardPayload(externalId: string, overrides: Record<string, unknown>): string {
  return JSON.stringify(
    LeaderboardCardSchema.parse({
      item: {
        id: String(idOf(externalId)),
        source: 'github',
        kind: 'repo',
        externalId,
        displayName: externalId,
        description: `${externalId} description`,
        url: `https://example.test/int/${externalId}`,
        language: 'TypeScript',
        topics: externalId === `${PREFIX}-a` ? [TOPIC] : [],
        primaryMetric: 'stars',
      },
      window: '24h',
      delta: 0,
      relGrowth: 0,
      score: 0,
      percentile: 0,
      current: 0,
      sparkline: [],
      flags: [],
      ...overrides,
    }),
  );
}

/** Keys this file seeds and asserts on; reset before and after. */
function boardKeys(): string[] {
  return [
    redisKeys.leaderboard('github', '24h'),
    redisKeys.leaderboardMeta('github', '24h'),
    redisKeys.leaderboard('all', '24h'),
    redisKeys.leaderboardMeta('all', '24h'),
    redisKeys.leaderboard('npm', '24h'),
    redisKeys.leaderboardMeta('npm', '24h'),
  ];
}

function cardKeys(): string[] {
  return ['a', 'b', 'c', 'd'].map((suffix) => redisKeys.card(idOf(`${PREFIX}-${suffix}`), '24h'));
}

/** Only `/v1/trending` writes `q:` keys (spec §9.1), so clearing them is safe. */
async function clearQueryCache(): Promise<void> {
  const keys = await redis.keys('q:*');
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

  // Idempotent re-runs: same job ids come back as the same run ids, so their
  // rows can be cleared before the fixtures are rebuilt.
  githubRun = await startRun(db, {
    source: 'github',
    jobType: 'score',
    jobId: `${PREFIX}-github-run`,
  });
  npmRun = await startRun(db, { source: 'npm', jobType: 'score', jobId: `${PREFIX}-npm-run` });
  npmRun2 = await startRun(db, {
    source: 'npm',
    jobType: 'score',
    jobId: `${PREFIX}-npm-run-2`,
  });
  githubRun2 = await startRun(db, {
    source: 'github',
    jobType: 'score',
    jobId: `${PREFIX}-github-run-2`,
  });

  const runIds = [githubRun, npmRun, npmRun2, githubRun2];
  await db.delete(scores).where(inArray(scores.runId, runIds));
  await db.delete(scoreRunsCurrent).where(inArray(scoreRunsCurrent.runId, runIds));
  // Foreign current runs (the seed-scoring file ran first in some orders) would
  // leak into `all`-scope joins; clear the table, then point it at this file's
  // runs below.
  await db.delete(scoreRunsCurrent);

  const upserted = await upsertItems(db, [
    itemFixture(`${PREFIX}-a`),
    itemFixture(`${PREFIX}-b`),
    itemFixture(`${PREFIX}-c`, {
      language: 'Python',
      upstreamCreatedAt: new Date(NOW.getTime() - 5 * DAY),
    }),
    itemFixture(`${PREFIX}-d`, {
      source: 'npm',
      kind: 'package',
      primaryMetric: 'downloads',
      language: null,
    }),
  ]);
  for (const row of upserted) ids.set(row.externalId, row.id);

  const [existingTopic] = await db.select().from(topics).where(eq(topics.slug, TOPIC));
  if (existingTopic === undefined) {
    await db.insert(topics).values({ slug: TOPIC, name: 'Int Test Topic' });
  }
  const [topicRow] = await db.select().from(topics).where(eq(topics.slug, TOPIC));
  if (topicRow === undefined) throw new Error('topic insert returned no row');
  topicId = topicRow.id;
  await db
    .insert(itemTopics)
    .values({ itemId: idOf(`${PREFIX}-a`), topicId })
    .onConflictDoNothing();

  // Series: three complete past days for A, two for B, one for C; daily counts
  // for D. C and D have no cards, so their entries hydrate from these rows.
  await upsertSnapshots(db, [
    snap(`${PREFIX}-a`, utcDaysAgo(3), 60),
    snap(`${PREFIX}-a`, utcDaysAgo(2), 80),
    snap(`${PREFIX}-a`, utcDaysAgo(1), 100),
    snap(`${PREFIX}-b`, utcDaysAgo(2), 50),
    snap(`${PREFIX}-b`, utcDaysAgo(1), 70),
    snap(`${PREFIX}-c`, utcDaysAgo(1), 40),
  ]);
  await upsertDailyMetrics(db, [
    daily(`${PREFIX}-d`, dayString(3), 1000),
    daily(`${PREFIX}-d`, dayString(2), 1100),
  ]);

  await insertScores(db, [
    scoreRow(`${PREFIX}-a`, 'github', githubRun, {
      finalScore: 30,
      zScore: 3,
      percentile: 99,
      delta: 300,
      relGrowth: 3,
      rankSource: 1,
      rankAll: 1,
    }),
    scoreRow(`${PREFIX}-b`, 'github', githubRun, {
      finalScore: 20,
      zScore: 2,
      percentile: 90,
      delta: 200,
      relGrowth: 2,
      rankSource: 2,
      rankAll: 3,
    }),
    scoreRow(`${PREFIX}-c`, 'github', githubRun, {
      finalScore: 10,
      zScore: 1,
      percentile: 50,
      delta: 100,
      relGrowth: 1,
      rankSource: 3,
      rankAll: 4,
      flags: ['new_item'],
    }),
    scoreRow(`${PREFIX}-d`, 'npm', npmRun, {
      finalScore: 25,
      zScore: 2.5,
      percentile: 95,
      delta: 500,
      relGrowth: 4,
      rankSource: 1,
      rankAll: 2,
    }),
  ]);
  await swapCurrentRun(db, {
    source: 'github',
    window: '24h',
    runId: githubRun,
    computedAt: COMPUTED_AT,
  });
  await swapCurrentRun(db, {
    source: 'npm',
    window: '24h',
    runId: npmRun,
    computedAt: COMPUTED_AT,
  });

  // Boards and cards, exactly as `publishBoard` leaves them.
  await redis.del(...boardKeys(), ...cardKeys());
  await clearQueryCache();

  await redis.zadd(
    redisKeys.leaderboard('github', '24h'),
    '30',
    String(idOf(`${PREFIX}-a`)),
    '20',
    String(idOf(`${PREFIX}-b`)),
    '10',
    String(idOf(`${PREFIX}-c`)),
  );
  await redis.hset(redisKeys.leaderboardMeta('github', '24h'), {
    runId: String(githubRun),
    computedAt: COMPUTED_AT.toISOString(),
    count: '3',
    version: '3',
  });
  await redis.zadd(
    redisKeys.leaderboard('all', '24h'),
    '3',
    String(idOf(`${PREFIX}-a`)),
    '2.5',
    String(idOf(`${PREFIX}-d`)),
    '2',
    String(idOf(`${PREFIX}-b`)),
    '1',
    String(idOf(`${PREFIX}-c`)),
  );
  await redis.hset(redisKeys.leaderboardMeta('all', '24h'), {
    runId: String(githubRun),
    computedAt: COMPUTED_AT.toISOString(),
    count: '4',
    version: '2',
  });
  await redis.set(
    redisKeys.card(idOf(`${PREFIX}-a`), '24h'),
    cardPayload(`${PREFIX}-a`, {
      delta: 300,
      relGrowth: 3,
      score: 30,
      percentile: 99,
      current: 100,
      sparkline: [60, 80, 100],
    }),
    'EX',
    600,
  );
  await redis.set(
    redisKeys.card(idOf(`${PREFIX}-b`), '24h'),
    cardPayload(`${PREFIX}-b`, {
      delta: 200,
      relGrowth: 2,
      score: 20,
      percentile: 90,
      current: 70,
      sparkline: [50, 70],
    }),
    'EX',
    600,
  );
});

afterAll(async () => {
  const runIds = [githubRun, npmRun, npmRun2, githubRun2];
  await db.delete(scores).where(inArray(scores.runId, runIds));
  await db.delete(scoreRunsCurrent).where(inArray(scoreRunsCurrent.runId, runIds));
  await db.delete(snapshots).where(inArray(snapshots.itemId, [...ids.values()]));
  await db.delete(items).where(like(items.externalId, `${PREFIX}-%`));
  await db.delete(topics).where(eq(topics.slug, TOPIC));
  await db.delete(ingestionRuns).where(inArray(ingestionRuns.id, runIds));
  await redis.del(...boardKeys(), ...cardKeys());
  await clearQueryCache();
  await redis.quit();
  await connection.pool.end();
});

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp({
    corsOrigins: ['http://localhost:3000'],
    metricsToken: 'int-trending-token',
    rateLimit: false,
    db: connection,
    redis,
  });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

function trending(app: FastifyInstance, url: string, headers: Record<string, string> = {}) {
  return app.inject({ method: 'GET', url: `/v1/trending${url}`, headers });
}

function externalIds(body: TrendingResponseBody): string[] {
  return body.data.map((entry) => entry.item.externalId);
}

function entryFor(body: TrendingResponseBody, externalId: string): LeaderboardEntry {
  const entry = body.data.find((candidate) => candidate.item.externalId === externalId);
  if (entry === undefined) throw new Error(`missing entry for ${externalId}`);
  return entry;
}

describe('GET /v1/trending over real Postgres + Redis (task 3.2)', () => {
  it('serves the Redis board with cards and hydrated entries, plus ETag/304 (spec §9.3, §9.4)', async () => {
    await withApp(async (app) => {
      const response = await trending(app, '?scope=github&window=24h');
      expect(response.statusCode).toBe(200);
      const body = TrendingResponse.parse(response.json<TrendingResponseBody>());
      expect(body.runId).toBe(String(githubRun));
      expect(body.computedAt).toBe(COMPUTED_AT.toISOString());
      expect(body.scope).toBe('github');
      expect(body.window).toBe('24h');
      expect(body.page).toEqual({ limit: 50, nextCursor: null });

      expect(body.data.map((entry) => entry.rank)).toEqual([1, 2, 3]);
      expect(entryFor(body, `${PREFIX}-a`)).toMatchObject({
        rank: 1,
        score: 30,
        delta: 300,
        relGrowth: 3,
        percentile: 99,
        current: 100,
        sparkline: [60, 80, 100],
        flags: [],
        item: {
          source: 'github',
          kind: 'repo',
          language: 'TypeScript',
          topics: [TOPIC],
          primaryMetric: 'stars',
        },
      });
      expect(entryFor(body, `${PREFIX}-b`)).toMatchObject({
        rank: 2,
        score: 20,
        current: 70,
        sparkline: [50, 70],
      });
      // C has no card: the entry hydrates from items + snapshots + scores.
      expect(entryFor(body, `${PREFIX}-c`)).toMatchObject({
        rank: 3,
        score: 10,
        delta: 100,
        percentile: 50,
        current: 40,
        sparkline: [40],
        flags: ['new_item'],
        item: { displayName: `${PREFIX}-c`, language: 'Python', topics: [] },
      });

      const etag = response.headers.etag;
      expect(etag).toMatch(/^W\/"lb-github-24h-3-[0-9a-f]{8}"$/);
      expect(response.headers['cache-control']).toBe(CACHE_CONTROL.publicLong);

      const cached = await trending(app, '?scope=github&window=24h', {
        'if-none-match': etag ?? '',
      });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe('');
      expect(cached.headers.etag).toBe(etag);
      expect(cached.headers['cache-control']).toBe(CACHE_CONTROL.publicLong);

      // `lang=_all` is the board's own language bucket — still the Redis path.
      const langAll = await trending(app, '?scope=github&window=24h&lang=_all');
      expect(externalIds(langAll.json<TrendingResponseBody>())).toEqual([
        `${PREFIX}-a`,
        `${PREFIX}-b`,
        `${PREFIX}-c`,
      ]);
    });
  });

  it('paginates by board score with run-pinned cursors (spec §10.2, §16)', async () => {
    await withApp(async (app) => {
      const page1Response = await trending(app, '?scope=github&window=24h&limit=2');
      const page1 = page1Response.json<TrendingResponseBody>();
      expect(externalIds(page1)).toEqual([`${PREFIX}-a`, `${PREFIX}-b`]);
      expect(page1.page.limit).toBe(2);
      const cursor = page1.page.nextCursor;
      expect(typeof cursor).toBe('string');
      // Spec §10.5 (task 3.4 backfill): pages with a next cursor carry the Link header.
      const link = String(page1Response.headers.link ?? '');
      expect(link).toContain(`cursor=${cursor ?? ''}`);
      expect(link).toContain('rel="next"');

      const page2Response = await trending(
        app,
        `?scope=github&window=24h&limit=2&cursor=${cursor ?? ''}`,
      );
      const page2 = page2Response.json<TrendingResponseBody>();
      expect(page2Response.statusCode).toBe(200);
      expect(externalIds(page2)).toEqual([`${PREFIX}-c`]);
      // Ranks are absolute board ranks, not page offsets.
      expect(page2.data.map((entry) => entry.rank)).toEqual([3]);
      expect(page2.page.nextCursor).toBeNull();
      expect(page2Response.headers.link).toBeUndefined();
      expect(page2.runId).toBe(page1.runId);
      // The cursor is part of the canonical query, so page 2 gets its own ETag.
      expect(page2Response.headers.etag).not.toBe(page1Response.headers.etag);
    });
  });

  it('rejects an undecodable cursor with 400 problem+json (spec §10.2)', async () => {
    await withApp(async (app) => {
      const response = await trending(app, '?scope=github&window=24h&cursor=%21%21%21');
      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json<{ type: string; detail?: string }>()).toMatchObject({
        type: 'https://trendr.dev/problems/validation-error',
        status: 400,
      });
    });
  });

  it('falls back to the SQL path when a board has no lbmeta (spec §9.3)', async () => {
    await withApp(async (app) => {
      const response = await trending(app, '?scope=npm&window=24h');
      expect(response.statusCode).toBe(200);
      const body = response.json<TrendingResponseBody>();
      expect(body.runId).toBe(String(npmRun));
      expect(body.computedAt).toBe(COMPUTED_AT.toISOString());
      expect(externalIds(body)).toEqual([`${PREFIX}-d`]);
      expect(entryFor(body, `${PREFIX}-d`)).toMatchObject({
        rank: 1,
        score: 25,
        current: 1100,
        sparkline: [1000, 1100],
        item: { source: 'npm', kind: 'package', primaryMetric: 'downloads', language: null },
      });
      // No lbmeta → no board ETag; the plugin mints the weak body hash instead.
      expect(response.headers.etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
    });
  });

  it('serves topic, kind and lang filters through SQL and caches at q:{sha1} (spec §9.1, §9.3)', async () => {
    await withApp(async (app) => {
      const byTopic = await trending(app, `?scope=github&window=24h&topic=${TOPIC}`);
      const topicBody = byTopic.json<TrendingResponseBody>();
      expect(externalIds(topicBody)).toEqual([`${PREFIX}-a`]);
      expect(entryFor(topicBody, `${PREFIX}-a`).item.topics).toEqual([TOPIC]);

      const qKey = redisKeys.queryCache(
        canonicalQuery(TrendingQuery.parse({ scope: 'github', window: '24h', topic: TOPIC })),
      );
      const cachedRaw = await redis.get(qKey);
      expect(cachedRaw).not.toBeNull();
      expect(TrendingResponse.safeParse(JSON.parse(cachedRaw ?? 'null')).success).toBe(true);

      const byKind = await trending(app, '?scope=github&window=24h&kind=repo');
      expect(externalIds(byKind.json<TrendingResponseBody>())).toEqual([
        `${PREFIX}-a`,
        `${PREFIX}-b`,
        `${PREFIX}-c`,
      ]);

      const byLang = await trending(app, '?scope=github&window=24h&lang=python');
      const langBody = byLang.json<TrendingResponseBody>();
      expect(externalIds(langBody)).toEqual([`${PREFIX}-c`]);
      expect(entryFor(langBody, `${PREFIX}-c`).score).toBe(10);

      const byLangTs = await trending(app, '?scope=github&window=24h&lang=typescript');
      expect(externalIds(byLangTs.json<TrendingResponseBody>())).toEqual([
        `${PREFIX}-a`,
        `${PREFIX}-b`,
      ]);
    });
  });

  it('applies minCurrent with a keyset top-up across pages (spec §10.3)', async () => {
    await withApp(async (app) => {
      const filtered = await trending(app, '?scope=github&window=24h&minCurrent=60');
      const filteredBody = filtered.json<TrendingResponseBody>();
      expect(externalIds(filteredBody)).toEqual([`${PREFIX}-a`, `${PREFIX}-b`]);
      expect(filteredBody.page.nextCursor).toBeNull();

      // C (current 40) fails the filter; the top-up loop still terminates.
      const page1 = (
        await trending(app, '?scope=github&window=24h&minCurrent=60&limit=1')
      ).json<TrendingResponseBody>();
      expect(externalIds(page1)).toEqual([`${PREFIX}-a`]);
      expect(typeof page1.page.nextCursor).toBe('string');

      const page2 = (
        await trending(
          app,
          `?scope=github&window=24h&minCurrent=60&limit=1&cursor=${page1.page.nextCursor ?? ''}`,
        )
      ).json<TrendingResponseBody>();
      expect(externalIds(page2)).toEqual([`${PREFIX}-b`]);
      expect(page2.page.nextCursor).toBeNull();
    });
  });

  it('parses newOnly=true/false/1/0 and rejects newOnly=yes (spec §10.3, §16)', async () => {
    await withApp(async (app) => {
      const recent = await trending(app, '?scope=github&window=24h&newOnly=true');
      expect(externalIds(recent.json<TrendingResponseBody>())).toEqual([`${PREFIX}-c`]);

      const one = await trending(app, '?scope=github&window=24h&newOnly=1');
      expect(externalIds(one.json<TrendingResponseBody>())).toEqual([`${PREFIX}-c`]);

      // `false` is not a filter: the unfiltered board read serves all three.
      const all = await trending(app, '?scope=github&window=24h&newOnly=false');
      expect(externalIds(all.json<TrendingResponseBody>())).toEqual([
        `${PREFIX}-a`,
        `${PREFIX}-b`,
        `${PREFIX}-c`,
      ]);

      const bad = await trending(app, '?scope=github&window=24h&newOnly=yes');
      expect(bad.statusCode).toBe(400);
      expect(bad.headers['content-type']).toContain('application/problem+json');
      expect(bad.json<{ type: string }>().type).toBe(
        'https://trendr.dev/problems/validation-error',
      );
    });
  });

  it('serves the combined board from Redis and z_scores on its SQL path (spec §9.1)', async () => {
    await withApp(async (app) => {
      const board = (await trending(app, '?window=24h')).json<TrendingResponseBody>();
      expect(externalIds(board)).toEqual([
        `${PREFIX}-a`,
        `${PREFIX}-d`,
        `${PREFIX}-b`,
        `${PREFIX}-c`,
      ]);
      expect(board.data.map((entry) => entry.rank)).toEqual([1, 2, 3, 4]);
      // D has no card: hydration serves the source score the card would carry.
      expect(entryFor(board, `${PREFIX}-d`)).toMatchObject({
        rank: 2,
        score: 25,
        current: 1100,
        sparkline: [1000, 1100],
      });

      // Filtered combined reads page in z_score order and serve z_scores.
      const filtered = (
        await trending(app, '?window=24h&minCurrent=90')
      ).json<TrendingResponseBody>();
      expect(externalIds(filtered)).toEqual([`${PREFIX}-a`, `${PREFIX}-d`]);
      expect(entryFor(filtered, `${PREFIX}-a`)).toMatchObject({ rank: 1, score: 3 });
      expect(entryFor(filtered, `${PREFIX}-d`)).toMatchObject({ rank: 2, score: 2.5 });
    });
  });

  it('keeps github pages stable while another source is rescored (spec §16)', async () => {
    await withApp(async (app) => {
      const page1 = (
        await trending(app, '?scope=github&window=24h&limit=2')
      ).json<TrendingResponseBody>();
      const cursor = page1.page.nextCursor;
      expect(typeof cursor).toBe('string');

      // An npm scoring run swaps npm's current run; github's board is untouched.
      await db.delete(scores).where(and(eq(scores.source, 'npm'), eq(scores.runId, npmRun2)));
      await insertScores(db, [
        scoreRow(`${PREFIX}-d`, 'npm', npmRun2, {
          finalScore: 55,
          zScore: 9.9,
          percentile: 40,
          delta: 999,
          relGrowth: 5,
          rankSource: 1,
          rankAll: 2,
        }),
      ]);
      await swapCurrentRun(db, {
        source: 'npm',
        window: '24h',
        runId: npmRun2,
        computedAt: COMPUTED_AT_2,
      });

      const page2Response = await trending(
        app,
        `?scope=github&window=24h&limit=2&cursor=${cursor ?? ''}`,
      );
      expect(page2Response.statusCode).toBe(200);
      const page2 = page2Response.json<TrendingResponseBody>();
      expect(externalIds(page2)).toEqual([`${PREFIX}-c`]);
      expect(page2.runId).toBe(String(githubRun));
      expect(await redis.hget(redisKeys.leaderboardMeta('github', '24h'), 'runId')).toBe(
        String(githubRun),
      );
    });
  });

  it('returns 410 cursor-expired when the board was rebuilt (spec §16)', async () => {
    await withApp(async (app) => {
      const page1 = (
        await trending(app, '?scope=github&window=24h&limit=2')
      ).json<TrendingResponseBody>();
      const cursor = page1.page.nextCursor;
      expect(typeof cursor).toBe('string');

      // A github rebuild bumps lbmeta to the new run.
      await redis.hset(redisKeys.leaderboardMeta('github', '24h'), {
        runId: String(githubRun2),
        computedAt: COMPUTED_AT_2.toISOString(),
        version: '4',
      });

      const stale = await trending(app, `?scope=github&window=24h&limit=2&cursor=${cursor ?? ''}`);
      expect(stale.statusCode).toBe(410);
      expect(stale.headers['content-type']).toContain('application/problem+json');
      expect(stale.json<{ type: string; detail?: string }>()).toMatchObject({
        type: 'https://trendr.dev/problems/cursor-expired',
        status: 410,
      });

      // Restarting without the cursor reads the rebuilt board's run id.
      const fresh = (await trending(app, '?scope=github&window=24h')).json<TrendingResponseBody>();
      expect(fresh.runId).toBe(String(githubRun2));
      expect(externalIds(fresh)).toEqual([`${PREFIX}-a`, `${PREFIX}-b`, `${PREFIX}-c`]);
    });
  });
});
