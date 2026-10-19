import { eq, inArray, like, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { redisKeys } from '@trendr/core';
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
import { CompareResponse, type CompareBody } from '../../src/schemas/compare.js';
import {
  NewResponse,
  SearchQuery,
  SearchResponse,
  type SearchResponseBody,
} from '../../src/schemas/search.js';
import { StatsResponse, type StatsBody } from '../../src/schemas/stats.js';
import { LanguagesResponse, TopicsResponse, type TopicsBody } from '../../src/schemas/topics.js';
import { canonicalSearchQuery, decodeSearchCursor } from '../../src/services/search.service.js';

/**
 * Task 3.4 acceptance (spec §10.1, §10.5, §18) over real Postgres + Redis:
 * `/v1/search` with the pg_trgm fallback (the `nxt` → `vercel/next.js` pair),
 * `/v1/new`, `/v1/topics`, `/v1/languages`, `/v1/compare` and `/v1/stats`,
 * plus problem+json validation/404 behaviour and the §10.5 Link header.
 */

const PREFIX = 'int-search';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const NOW = new Date();

/** Midnight-anchored UTC day `days` before today (hour 12 avoids same-day edges). */
function utcDaysAgo(days: number, hour = 12): Date {
  return new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate() - days, hour));
}

function dayString(t: Date): string {
  return t.toISOString().slice(0, 10);
}

const D3 = utcDaysAgo(3);
const D2 = utcDaysAgo(2);
const H2 = new Date(NOW.getTime() - 2 * HOUR_MS);
const H1 = new Date(NOW.getTime() - HOUR_MS);
const OLD = new Date(NOW.getTime() - 300 * DAY_MS); // outside every /new window

let connection: Connection;
let db: Db;
let redis: Redis;

let runScores = 0n;
let runDiscoverOld = 0n;
let runDiscoverNew = 0n;
let runDiscoverFailed = 0n;
let runMaint = 0n;

const ids = new Map<string, bigint>();

/**
 * Live counts captured before this file's fixtures land. The seed int test
 * leaves ~200 items in the shared database (§7.3), so absolute totals are not
 * stable — assertions compare against baseline + this file's known delta.
 */
let sourceBaseline = new Map<string, number>();
let languageBaseline = new Map<string, number>();

function idOf(key: string): bigint {
  const id = ids.get(key);
  if (id === undefined) throw new Error(`missing fixture ${key}`);
  return id;
}

function itemFixture(key: string, overrides: Partial<ItemUpsert> = {}): ItemUpsert {
  return {
    source: 'github',
    kind: 'repo',
    externalId: `${PREFIX}-${key}`,
    upstreamId: null,
    name: key,
    displayName: key,
    description: `${key} description`,
    url: `https://example.test/${PREFIX}/${key}`,
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: PREFIX,
    primaryMetric: 'stars',
    upstreamCreatedAt: OLD,
    isArchived: false,
    metadata: { suite: PREFIX },
    ...overrides,
  };
}

function snap(key: string, capturedAt: Date, value: number): SnapshotUpsert {
  return { itemId: idOf(key), metric: 'stars', capturedAt, observedAt: capturedAt, value };
}

function scoreRow(
  key: string,
  runId: bigint,
  finalScore: number,
  overrides: Partial<ScoreUpsert> = {},
): ScoreUpsert {
  return {
    itemId: idOf(key),
    window: '24h',
    runId,
    source: 'github',
    computedAt: NOW,
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

/** Only `/v1/search` writes `q:` keys (spec §9.1). */
async function clearSearchCaches(): Promise<void> {
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

  // Seed-aware baselines (see the declaration comment): the route counts every
  // non-deleted item, grouped by source / exact language string.
  const sourceRows = await db.execute<{ source: string; n: number }>(sql`
    SELECT source, count(*)::int AS n
    FROM items WHERE is_deleted = false
    GROUP BY source`);
  sourceBaseline = new Map(sourceRows.rows.map((row) => [row.source, row.n]));
  const languageRows = await db.execute<{ language: string; n: number }>(sql`
    SELECT language, count(*)::int AS n
    FROM items WHERE is_deleted = false AND language IS NOT NULL
    GROUP BY language`);
  languageBaseline = new Map(languageRows.rows.map((row) => [row.language, row.n]));

  const bulk = Array.from({ length: 60 }, (_, index) =>
    itemFixture(`bulk-${String(index + 1).padStart(2, '0')}`, {
      upstreamCreatedAt: new Date(NOW.getTime() - (index + 1) * HOUR_MS),
    }),
  );

  const upserted = await upsertItems(db, [
    // Search fixtures: `nova-*`/`quasar-*` FTS-material, `novax`/`quasarql`/`quasarx`
    // trigram-only (no FTS token equality), `gorp-item` soft-deleted.
    itemFixture('next', {
      name: 'next.js',
      displayName: 'vercel/next.js',
      description: 'The React Framework',
      language: 'JavaScript',
    }),
    itemFixture('quasar-a', { displayName: 'quasar-a', language: 'Rust' }),
    itemFixture('quasar-b', { displayName: 'quasar-b' }),
    itemFixture('quasarql', { displayName: 'quasarql', language: 'Rust' }),
    itemFixture('quasarx', {
      source: 'huggingface',
      kind: 'model',
      displayName: 'quasarx',
      language: null,
      primaryMetric: 'downloads',
    }),
    itemFixture('novapkg', {
      source: 'npm',
      kind: 'package',
      displayName: 'novapkg',
      language: null,
      primaryMetric: 'downloads',
    }),
    ...Array.from({ length: 6 }, (_, index) =>
      itemFixture(`nova-${index + 1}`, { displayName: `nova-${index + 1}` }),
    ),
    itemFixture('novax', { displayName: 'novax', language: 'Go' }),
    itemFixture('deleted', { displayName: 'gorp-item' }),
    // /new fixtures: inside and outside the 1..30 d window, plus null/soft-deleted.
    itemFixture('fresh-1', {
      displayName: 'fresh-1',
      language: null,
      upstreamCreatedAt: new Date(NOW.getTime() - 26.5 * HOUR_MS),
    }),
    itemFixture('fresh-2', {
      displayName: 'fresh-2',
      language: null,
      upstreamCreatedAt: new Date(NOW.getTime() - 3 * DAY_MS),
    }),
    itemFixture('fresh-3', {
      displayName: 'fresh-3',
      language: null,
      upstreamCreatedAt: new Date(NOW.getTime() - 10 * DAY_MS),
    }),
    itemFixture('fresh-null', { displayName: 'fresh-null', language: null }),
    itemFixture('fresh-deleted', {
      displayName: 'fresh-deleted',
      language: 'COBOL',
      upstreamCreatedAt: new Date(NOW.getTime() - DAY_MS),
    }),
    itemFixture('npm-fresh', {
      source: 'npm',
      kind: 'package',
      displayName: 'npm-fresh',
      language: null,
      primaryMetric: 'downloads',
      upstreamCreatedAt: new Date(NOW.getTime() - 48.5 * HOUR_MS),
    }),
    ...bulk,
  ]);
  for (const row of upserted) ids.set(row.externalId.slice(PREFIX.length + 1), row.id);

  await db
    .update(items)
    .set({ isDeleted: true })
    .where(inArray(items.id, [idOf('deleted'), idOf('fresh-deleted')]));
  await db
    .update(items)
    .set({ upstreamCreatedAt: null })
    .where(eq(items.id, idOf('fresh-null')));

  for (const slug of [`${PREFIX}-topic-a`, `${PREFIX}-topic-b`]) {
    const [existing] = await db.select().from(topics).where(eq(topics.slug, slug));
    if (existing === undefined) {
      await db.insert(topics).values({ slug, name: `Int Search ${slug}` });
    }
  }
  const topicRows = await db
    .select()
    .from(topics)
    .where(inArray(topics.slug, [`${PREFIX}-topic-a`, `${PREFIX}-topic-b`]));
  const topicA = topicRows.find((row) => row.slug === `${PREFIX}-topic-a`);
  const topicB = topicRows.find((row) => row.slug === `${PREFIX}-topic-b`);
  if (topicA === undefined || topicB === undefined) throw new Error('topic fixtures missing');
  await db
    .insert(itemTopics)
    .values([
      { itemId: idOf('quasar-a'), topicId: topicA.id },
      { itemId: idOf('quasar-b'), topicId: topicA.id },
      { itemId: idOf('novapkg'), topicId: topicA.id },
      { itemId: idOf('nova-1'), topicId: topicB.id },
      { itemId: idOf('nova-2'), topicId: topicB.id },
    ])
    .onConflictDoNothing();

  await upsertSnapshots(db, [
    snap('quasar-a', D3, 90),
    snap('quasar-a', D2, 100),
    snap('quasar-a', H2, 104),
    snap('quasar-a', H1, 107),
  ]);

  runScores = await startRun(db, { source: 'github', jobType: 'score', jobId: `${PREFIX}-scores` });
  await db.delete(scores).where(inArray(scores.runId, [runScores]));
  await db.delete(scoreRunsCurrent).where(inArray(scoreRunsCurrent.runId, [runScores]));
  await insertScores(db, [
    scoreRow('quasar-a', runScores, 6, {
      delta: 42,
      relGrowth: 0.2956,
      percentile: 97,
      rankSource: 1,
    }),
    scoreRow('quasar-a', runScores, 9.5, {
      window: '7d',
      delta: 10,
      relGrowth: 0.5,
      percentile: 80,
      rankSource: 2,
    }),
    scoreRow('nova-1', runScores, 3, { delta: 5, percentile: 60, rankSource: 3 }),
  ]);
  // Only this file's current runs (stale pointers from an earlier int file would
  // leak into compare/search score7d).
  await db.delete(scoreRunsCurrent);
  await swapCurrentRun(db, { source: 'github', window: '24h', runId: runScores, computedAt: NOW });
  await swapCurrentRun(db, { source: 'github', window: '7d', runId: runScores, computedAt: NOW });

  runDiscoverOld = await startRun(db, {
    source: 'github',
    jobType: 'discover',
    jobId: `${PREFIX}-discover-old`,
  });
  runDiscoverNew = await startRun(db, {
    source: 'github',
    jobType: 'discover',
    jobId: `${PREFIX}-discover-new`,
  });
  runDiscoverFailed = await startRun(db, {
    source: 'github',
    jobType: 'discover',
    jobId: `${PREFIX}-discover-failed`,
  });
  runMaint = await startRun(db, {
    source: null,
    jobType: 'maintenance',
    jobId: `${PREFIX}-maint`,
  });
  await db
    .update(ingestionRuns)
    .set({ status: 'succeeded', finishedAt: new Date(NOW.getTime() - 5 * 60_000) })
    .where(eq(ingestionRuns.id, runDiscoverOld));
  await db
    .update(ingestionRuns)
    .set({ status: 'succeeded', finishedAt: new Date(NOW.getTime() - 60_000) })
    .where(eq(ingestionRuns.id, runDiscoverNew));
  // The failed run finishes *after* the succeeded one; the status filter must
  // keep it out (it would win the DISTINCT ON otherwise).
  await db
    .update(ingestionRuns)
    .set({ status: 'failed', finishedAt: NOW })
    .where(eq(ingestionRuns.id, runDiscoverFailed));
  await db
    .update(ingestionRuns)
    .set({ status: 'succeeded', finishedAt: new Date(NOW.getTime() - 2 * 60_000) })
    .where(eq(ingestionRuns.id, runMaint));

  await clearSearchCaches();
});

afterAll(async () => {
  await db.delete(scores).where(inArray(scores.runId, [runScores]));
  await db.delete(scoreRunsCurrent).where(inArray(scoreRunsCurrent.runId, [runScores]));
  await db.delete(snapshots).where(inArray(snapshots.itemId, [...ids.values()]));
  await db.delete(items).where(like(items.externalId, `${PREFIX}-%`));
  await db.delete(topics).where(inArray(topics.slug, [`${PREFIX}-topic-a`, `${PREFIX}-topic-b`]));
  await db
    .delete(ingestionRuns)
    .where(
      inArray(ingestionRuns.id, [runDiscoverOld, runDiscoverNew, runDiscoverFailed, runMaint]),
    );
  await clearSearchCaches();
  await redis.quit();
  await connection.pool.end();
});

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp({
    corsOrigins: ['http://localhost:3000'],
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

const get = (app: FastifyInstance, url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

function assertProblem(
  response: { statusCode: number; headers: Record<string, unknown> },
  status: number,
): void {
  expect(response.statusCode).toBe(status);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
}

function itemIds(body: { items: { id: string }[] }): string[] {
  return body.items.map((item) => item.id);
}

type InjectHeaders = Record<string, string | number | string[] | undefined>;

function headerString(headers: InjectHeaders, name: string): string {
  const value = headers[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? '' : String(value);
}

/**
 * Walk every page of a cursor list, asserting §10.5 link headers: present with
 * the next cursor on non-final pages, absent on the final one.
 */
async function collectSearchPages(
  app: FastifyInstance,
  baseUrl: string,
): Promise<{ pages: string[][]; firstHeaders: InjectHeaders }> {
  const pages: string[][] = [];
  let cursor: string | null = null;
  let firstHeaders: InjectHeaders = {};
  for (let index = 0; index < 12; index += 1) {
    const response = await get(app, `${baseUrl}${cursor === null ? '' : `&cursor=${cursor}`}`);
    expect(response.statusCode).toBe(200);
    const body = SearchResponse.parse(response.json());
    if (index === 0) firstHeaders = response.headers;
    const next = body.page.nextCursor;
    if (next === null) {
      expect(response.headers.link).toBeUndefined();
    } else {
      const link = String(response.headers.link ?? '');
      expect(link).toContain(`cursor=${next}`);
      expect(link).toContain('rel="next"');
    }
    pages.push(itemIds(body));
    if (next === null) return { pages, firstHeaders };
    cursor = next;
  }
  throw new Error('search pagination did not terminate');
}

interface NewItemLike {
  id: string;
  source: string;
  kind: string;
  upstreamCreatedAt: string | null;
}

async function collectNewPages(
  app: FastifyInstance,
  query: string,
): Promise<{ items: NewItemLike[]; pageSizes: number[]; firstHeaders: InjectHeaders }> {
  const items: NewItemLike[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  let firstHeaders: InjectHeaders = {};
  for (let index = 0; index < 20; index += 1) {
    const suffix = cursor === null ? '' : `cursor=${cursor}`;
    const params = [query, suffix].filter((part) => part !== '').join('&');
    const response = await get(app, params === '' ? '/v1/new' : `/v1/new?${params}`);
    expect(response.statusCode).toBe(200);
    const body = NewResponse.parse(response.json());
    expect(body.page.limit).toBe(50);
    if (index === 0) firstHeaders = response.headers;
    pageSizes.push(body.items.length);
    items.push(...body.items);
    const next = body.page.nextCursor;
    if (next === null) {
      expect(response.headers.link).toBeUndefined();
    } else {
      const link = String(response.headers.link ?? '');
      expect(link).toContain(`cursor=${next}`);
      expect(link).toContain('rel="next"');
    }
    if (next === null) return { items, pageSizes, firstHeaders };
    cursor = next;
  }
  throw new Error('new pagination did not terminate');
}

describe('task 3.4 endpoints over real Postgres + Redis', () => {
  it('serves full-text search with §11.1 summaries and q: caching (spec §9.1, §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, '/v1/search?q=nova');
      expect(response.statusCode).toBe(200);
      const body = SearchResponse.parse(response.json<SearchResponseBody>());
      const expected = [1, 2, 3, 4, 5, 6].map((n) => String(idOf(`nova-${n}`)));
      expect(new Set(itemIds(body))).toEqual(new Set(expected));
      expect(body.page).toEqual({ nextCursor: null, limit: 50 });

      const first = body.items[0];
      expect(first).toMatchObject({
        source: 'github',
        kind: 'repo',
        current: null,
        score7d: null,
      });
      expect(first?.upstreamCreatedAt).not.toBeNull();

      expect(response.headers['cache-control']).toBe(CACHE_CONTROL.publicShort);
      const etag = response.headers.etag;
      expect(etag).toMatch(/^W\/"[0-9a-f]{40}"$/);
      const cacheKey = redisKeys.queryCache(canonicalSearchQuery(SearchQuery.parse({ q: 'nova' })));
      expect(await redis.exists(cacheKey)).toBe(1);
      const ttl = await redis.ttl(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120);

      const cached = await get(app, '/v1/search?q=nova', { 'if-none-match': etag ?? '' });
      expect(cached.statusCode).toBe(304);
      expect(cached.body).toBe('');
    });
  });

  it('suppresses the trigram tail when FTS finds five or more hits', async () => {
    await withApp(async (app) => {
      const body = SearchResponse.parse((await get(app, '/v1/search?q=nova')).json());
      expect(itemIds(body)).not.toContain(String(idOf('novax')));
      expect(itemIds(body)).not.toContain(String(idOf('novapkg')));

      // The same fuzzy neighbours *do* arrive when FTS finds nothing.
      const fallback = SearchResponse.parse((await get(app, '/v1/search?q=novaz')).json());
      expect(itemIds(fallback)).toContain(String(idOf('novax')));
      expect(itemIds(fallback)).toContain(String(idOf('novapkg')));
    });
  });

  it('finds vercel/next.js from a partial query via the trigram fallback (spec §18 acceptance)', async () => {
    await withApp(async (app) => {
      // FTS has no `nxt` lexeme; the fallback must surface `vercel/next.js`
      // (word_similarity 0.286). The seed's `nuxt/nuxt` legitimately ranks
      // higher (0.5), so assert presence, not the exact page.
      const response = await get(app, '/v1/search?q=nxt&limit=2');
      const body = SearchResponse.parse(response.json());
      expect(itemIds(body)).toContain(String(idOf('next')));
      expect(body.items.find((item) => item.id === String(idOf('next')))).toMatchObject({
        name: 'next.js',
        url: `https://example.test/${PREFIX}/next`,
      });
      // The cursor proves which path served the page: trigram, `both` mode.
      const cursor = decodeSearchCursor(body.page.nextCursor ?? '');
      expect(cursor).toMatchObject({ m: 'both', p: 'trigram' });

      const control = SearchResponse.parse((await get(app, '/v1/search?q=next')).json());
      expect(itemIds(control)).toContain(String(idOf('next')));
    });
  });

  it('excludes soft-deleted items from match and fallback paths', async () => {
    await withApp(async (app) => {
      const body = SearchResponse.parse((await get(app, '/v1/search?q=gorp')).json());
      // The seed leaves g-words behind, so assert the fixture is absent rather
      // than expecting an empty page.
      expect(itemIds(body)).not.toContain(String(idOf('deleted')));
    });
  });

  it('paginates FTS hits then the trigram tail with a two-part cursor (spec §10.2, §10.5)', async () => {
    await withApp(async (app) => {
      const { pages, firstHeaders } = await collectSearchPages(app, '/v1/search?q=quasar&limit=2');
      const collected = pages.flat();
      // Page 1 is the FTS part, page 2 the top of the trigram tail; seed items
      // (if any) can extend later pages but can never outrank these four.
      expect(new Set(collected.slice(0, 2))).toEqual(
        new Set([String(idOf('quasar-a')), String(idOf('quasar-b'))]),
      );
      expect(new Set(collected.slice(2, 4))).toEqual(
        new Set([String(idOf('quasarql')), String(idOf('quasarx'))]),
      );
      expect(collected.length).toBeGreaterThanOrEqual(4);
      expect(new Set(collected).size).toBe(collected.length);
      expect(headerString(firstHeaders, 'link')).toContain('rel="next"');
    });
  });

  it('filters search by source and kind on both paths (spec §10.1)', async () => {
    await withApp(async (app) => {
      // `quasarx` (0.857) is the best Hugging Face match; seed n/q-words can
      // trail it, but the filter must hold for every row.
      const bySource = SearchResponse.parse(
        (await get(app, '/v1/search?q=quasar&source=huggingface')).json(),
      );
      expect(bySource.items[0]?.id).toBe(String(idOf('quasarx')));
      expect(bySource.items.every((item) => item.source === 'huggingface')).toBe(true);

      // `novaz` trigram-matches the npm packages (0.667/0.167) — kind-filtered.
      const byKind = SearchResponse.parse(
        (await get(app, '/v1/search?q=novaz&kind=package')).json(),
      );
      expect(itemIds(byKind).slice(0, 2)).toEqual([
        String(idOf('novapkg')),
        String(idOf('npm-fresh')),
      ]);
      expect(byKind.items.every((item) => item.kind === 'package')).toBe(true);

      // Source filter on the fallback path: `novapkg` (0.8) leads the npm set.
      const fallbackNpm = SearchResponse.parse(
        (await get(app, '/v1/search?q=nova&source=npm')).json(),
      );
      expect(itemIds(fallbackNpm).slice(0, 2)).toEqual([
        String(idOf('novapkg')),
        String(idOf('npm-fresh')),
      ]);
      expect(fallbackNpm.items.every((item) => item.source === 'npm')).toBe(true);
    });
  });

  it('rejects short queries and malformed cursors with 400 problem+json', async () => {
    await withApp(async (app) => {
      assertProblem(await get(app, '/v1/search?q=x'), 400);
      assertProblem(await get(app, '/v1/search?q=nova&cursor=%21%21%21'), 400);
      // A cursor from another endpoint (KeysetCursor shape) is not a search cursor.
      const foreign = Buffer.from(JSON.stringify({ k: 1, i: '2' })).toString('base64url');
      assertProblem(await get(app, `/v1/search?q=nova&cursor=${foreign}`), 400);
      assertProblem(await get(app, '/v1/search'), 400);

      // `9x9x9` shares no trigram (not even a boundary one) with any fixture.
      const empty = SearchResponse.parse((await get(app, '/v1/search?q=9x9x9')).json());
      expect(empty.items).toEqual([]);
      expect(empty.page).toEqual({ nextCursor: null, limit: 50 });
    });
  });

  it('lists newly discovered items newest-first in fixed 50-item pages (spec §10.1, §10.5)', async () => {
    await withApp(async (app) => {
      const { items, pageSizes, firstHeaders } = await collectNewPages(app, '');
      expect(pageSizes[0]).toBe(50);
      const collected = items.map((item) => item.id);
      expect(new Set(collected).size).toBe(collected.length);
      expect(items[0]?.id).toBe(String(idOf('bulk-01')));
      expect(items[0]).toMatchObject({ source: 'github', kind: 'repo' });

      // In-window fixtures are listed; null/deleted/too-old ones are not. (The
      // seed may contribute its own in-window arxiv/MCP items.)
      for (const key of ['bulk-01', 'bulk-60', 'fresh-1', 'fresh-2', 'npm-fresh']) {
        expect(collected).toContain(String(idOf(key)));
      }
      for (const key of ['fresh-3', 'fresh-null', 'fresh-deleted']) {
        expect(collected).not.toContain(String(idOf(key)));
      }

      const times = items.map((item) => Date.parse(item.upstreamCreatedAt ?? ''));
      for (let index = 1; index < times.length; index += 1) {
        expect(times[index - 1]).toBeGreaterThanOrEqual(times[index] ?? 0);
      }
      expect(firstHeaders['cache-control']).toBe(CACHE_CONTROL.publicShort);

      const etag = headerString(firstHeaders, 'etag');
      const cached = await get(app, '/v1/new', { 'if-none-match': etag });
      expect(cached.statusCode).toBe(304);
    });
  });

  it('widens /v1/new to 30 days and filters by source (spec §10.1)', async () => {
    await withApp(async (app) => {
      const month = await collectNewPages(app, 'days=30');
      expect(month.items.map((item) => item.id)).toContain(String(idOf('fresh-3')));

      const npm = await collectNewPages(app, 'source=npm');
      expect(npm.items[0]?.id).toBe(String(idOf('npm-fresh')));
      expect(npm.items.every((item) => item.source === 'npm')).toBe(true);
      expect(npm.items.map((item) => item.id)).toContain(String(idOf('npm-fresh')));

      assertProblem(await get(app, '/v1/new?days=0'), 400);
      assertProblem(await get(app, '/v1/new?days=31'), 400);
      assertProblem(await get(app, '/v1/new?cursor=%21%21%21'), 400);
    });
  });

  it('serves live topic counts with the source filter (spec §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, '/v1/topics');
      expect(response.statusCode).toBe(200);
      const body = TopicsResponse.parse(response.json<TopicsBody>());
      const topicA = body.topics.findIndex((topic) => topic.slug === `${PREFIX}-topic-a`);
      const topicB = body.topics.findIndex((topic) => topic.slug === `${PREFIX}-topic-b`);
      expect(topicA).toBeGreaterThanOrEqual(0);
      expect(body.topics[topicA]?.itemCount).toBe(3);
      expect(topicB).toBeGreaterThan(topicA); // 3 > 2 items, count-descending
      expect(body.topics[topicB]?.itemCount).toBe(2);

      const npm = TopicsResponse.parse((await get(app, '/v1/topics?source=npm')).json());
      const npmTopicA = npm.topics.find((topic) => topic.slug === `${PREFIX}-topic-a`);
      expect(npmTopicA?.itemCount).toBe(1);
      expect(npm.topics.some((topic) => topic.slug === `${PREFIX}-topic-b`)).toBe(false);

      const limited = TopicsResponse.parse((await get(app, '/v1/topics?limit=1')).json());
      expect(limited.topics).toHaveLength(1);
      assertProblem(await get(app, '/v1/topics?limit=201'), 400);
    });
  });

  it('serves languages by live item count (spec §9.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, '/v1/languages');
      expect(response.statusCode).toBe(200);
      const body = LanguagesResponse.parse(response.json());
      expect(body.languages.length).toBeLessThanOrEqual(30);
      // The seed shares the database (and groups by the exact language string),
      // so assert baseline + this file's deltas.
      const rust = body.languages.find((entry) => entry.slug === 'rust');
      expect(rust).toMatchObject({
        language: 'Rust',
        itemCount: (languageBaseline.get('Rust') ?? 0) + 2,
      });
      const go = body.languages.find((entry) => entry.slug === 'go');
      expect(go?.itemCount).toBe((languageBaseline.get('Go') ?? 0) + 1);
      const typescript = body.languages.find((entry) => entry.slug === 'typescript');
      expect(typescript?.itemCount).toBe((languageBaseline.get('TypeScript') ?? 0) + 67);
      // The soft-deleted COBOL item must not appear.
      expect(body.languages.some((entry) => entry.slug === 'cobol')).toBe(false);
      const typescriptIndex = body.languages.findIndex((entry) => entry.slug === 'typescript');
      expect(typescriptIndex).toBeGreaterThanOrEqual(0);
      expect(typescriptIndex).toBeLessThan(
        body.languages.findIndex((entry) => entry.slug === 'rust'),
      );
    });
  });

  it('compares items with current-run growth and per-item series (spec §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, `/v1/compare?ids=${idOf('quasar-a')},${idOf('nova-2')}`);
      expect(response.statusCode).toBe(200);
      const body = CompareResponse.parse(response.json<CompareBody>());
      expect(body.window).toBe('24h');
      expect(body.granularity).toBe('hour');
      expect(body.metric).toBeNull();

      expect(body.items[0]).toMatchObject({
        id: String(idOf('quasar-a')),
        source: 'github',
        displayName: 'quasar-a',
        delta: 42,
        relGrowth: 0.2956,
        percentile: 97,
        rankSource: 1,
      });
      expect(body.items[1]).toMatchObject({
        id: String(idOf('nova-2')),
        delta: null,
        relGrowth: null,
        percentile: null,
        rankSource: null,
      });

      expect(body.series[String(idOf('quasar-a'))]).toEqual([
        { t: H2.toISOString(), v: 104 },
        { t: H1.toISOString(), v: 107 },
      ]);
      expect(body.series[String(idOf('nova-2'))]).toEqual([]);

      expect(response.headers['cache-control']).toBe(CACHE_CONTROL.publicShort);
      const etag = response.headers.etag;
      const cached = await get(app, `/v1/compare?ids=${idOf('quasar-a')},${idOf('nova-2')}`, {
        'if-none-match': etag ?? '',
      });
      expect(cached.statusCode).toBe(304);
    });
  });

  it('compares over day granularity and rejects hour granularity for 30d (spec §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(
        app,
        `/v1/compare?ids=${idOf('quasar-a')},${idOf('nova-2')}&window=7d&granularity=day&metric=stars`,
      );
      expect(response.statusCode).toBe(200);
      const body = CompareResponse.parse(response.json());
      expect(body).toMatchObject({ window: '7d', granularity: 'day', metric: 'stars' });
      const points = body.series[String(idOf('quasar-a'))] ?? [];
      expect(points.find((point) => point.t === dayString(D3))?.v).toBe(90);
      expect(points.find((point) => point.t === dayString(D2))?.v).toBe(100);
      const times = points.map((point) => point.t);
      expect([...times].sort()).toEqual(times);
      expect(body.series[String(idOf('nova-2'))]).toEqual([]);

      // 30d defaults to day; hour is refused like /v1/items/:id/history.
      const month = CompareResponse.parse(
        (await get(app, `/v1/compare?ids=${idOf('quasar-a')},${idOf('nova-2')}&window=30d`)).json(),
      );
      expect(month.granularity).toBe('day');
      assertProblem(
        await get(
          app,
          `/v1/compare?ids=${idOf('quasar-a')},${idOf('nova-2')}&window=30d&granularity=hour`,
        ),
        400,
      );
    });
  });

  it('validates compare ids and 404s unknown items (spec §10.1)', async () => {
    await withApp(async (app) => {
      assertProblem(await get(app, '/v1/compare?ids=1'), 400);
      assertProblem(await get(app, '/v1/compare?ids=1,2,3,4,5,6'), 400);
      assertProblem(await get(app, '/v1/compare?ids=1,1'), 400);
      assertProblem(await get(app, '/v1/compare?ids=1,x'), 400);
      assertProblem(await get(app, '/v1/compare'), 400);
      assertProblem(await get(app, `/v1/compare?ids=999999999999,${idOf('quasar-a')}`), 404);
      assertProblem(await get(app, '/v1/compare?ids=1,9223372036854775808'), 404);
    });
  });

  it('reports item counts per source and last successes (spec §10.1)', async () => {
    await withApp(async (app) => {
      const response = await get(app, '/v1/stats');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe(CACHE_CONTROL.noStore);
      const body = StatsResponse.parse(response.json<StatsBody>());
      // Baseline (seed, when present) + this file's fixtures; soft-deleted
      // fixtures are excluded by the route.
      expect(body.items).toEqual({
        github: (sourceBaseline.get('github') ?? 0) + 75,
        npm: (sourceBaseline.get('npm') ?? 0) + 2,
        pypi: sourceBaseline.get('pypi') ?? 0,
        huggingface: (sourceBaseline.get('huggingface') ?? 0) + 1,
        arxiv: sourceBaseline.get('arxiv') ?? 0,
        mcp: sourceBaseline.get('mcp') ?? 0,
      });

      const discover = body.runs.find(
        (run) => run.source === 'github' && run.jobType === 'discover',
      );
      expect(discover?.runId).toBe(String(runDiscoverNew));
      expect(discover?.lastSuccessAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.runs.some((run) => run.runId === String(runDiscoverFailed))).toBe(false);
      const maintenance = body.runs.find(
        (run) => run.source === null && run.jobType === 'maintenance',
      );
      expect(maintenance?.runId).toBe(String(runMaint));
    });
  });
});
