import { createHash } from 'node:crypto';

import { and, asc, desc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import {
  AppError,
  CursorExpiredError,
  LeaderboardCardSchema,
  ValidationError,
  redisKeys,
  type LeaderboardCard,
  type LeaderboardScope,
  type Window,
} from '@trendr/core';
import {
  itemTopics,
  items,
  loadCardItems,
  loadCardSeries,
  scoreRunsCurrent,
  scores,
  topics,
  type CardItem,
  type CardSeries,
  type Db,
} from '@trendr/db';

import { CACHE_CONTROL, ifNoneMatchMatches } from '../plugins/etag.js';
import {
  KeysetCursor,
  LeaderboardCursor,
  decodeCursor,
  encodeCursor,
  nextLinkHeader,
} from '../schemas/common.js';
import {
  TrendingQuery,
  TrendingResponse,
  type LeaderboardEntry,
  type TrendingQueryInput,
  type TrendingResponseBody,
} from '../schemas/trending.js';

/**
 * Spec §9.3 — `GET /v1/trending`. The unfiltered read is served from the
 * Redis boards (`lbmeta` → ETag/304 → `ZRANGEBYSCORE REV` → `MGET card:*`,
 * no Postgres hit; missing cards hydrate from Postgres). Any topic/kind/
 * minCurrent filter — and `newOnly=true`, which needs `upstream_created_at`
 * that cards do not carry — goes through the SQL path over `scores` joined
 * with `score_runs_current` and `items`, keyset-paginated and cached under
 * `q:{sha1}` for 60 s. A cursor pinned to a rebuilt board returns 410
 * `cursor-expired` (spec §16) so pages never mix runs.
 */

const EPOCH_ISO = new Date(0).toISOString();
const NEW_ITEM_DAYS = 30;
const DAY_MS = 86_400_000;
/** Spec §9.1: `q:{sha1}` filtered-result cache lives 60 s. */
const QUERY_CACHE_TTL_SECONDS = 60;

interface BoardMeta {
  runId: string;
  computedAt: string;
  version: string;
}

interface BoardPair {
  member: string;
  score: number;
}

/** Everything a response entry needs, before it gets a rank. */
interface EntryData {
  item: CardItem;
  series: CardSeries;
  delta: number;
  relGrowth: number;
  score: number;
  percentile: number;
  flags: LeaderboardEntry['flags'];
}

/** Canonical request key for the ETag hash and the `q:` cache (§9.1, §9.4). */
export function canonicalQuery(query: TrendingQueryInput): string {
  return JSON.stringify({
    scope: query.scope,
    window: query.window,
    lang: query.lang ?? null,
    topic: query.topic ?? null,
    kind: query.kind ?? null,
    newOnly: query.newOnly,
    minCurrent: query.minCurrent ?? null,
    limit: query.limit,
    cursor: query.cursor ?? null,
  });
}

/** Spec §9.4: `W/"lb-{scope}-{window}-{version}-{sha1(query).slice(0,8)}"`. */
export function trendingEtag(
  scope: LeaderboardScope,
  window: Window,
  version: string,
  query: TrendingQueryInput,
): string {
  const hash = createHash('sha1').update(canonicalQuery(query)).digest('hex').slice(0, 8);
  return `W/"lb-${scope}-${window}-${version}-${hash}"`;
}

/** Requests that cannot be served by the `lb:` ZSETs (spec §9.3). */
export function hasSqlFilters(query: TrendingQueryInput): boolean {
  return (
    query.topic !== undefined ||
    query.kind !== undefined ||
    query.minCurrent !== undefined ||
    query.newOnly
  );
}

function toIsoOrEpoch(value: string | undefined): string {
  if (value === undefined || Number.isNaN(Date.parse(value))) {
    return EPOCH_ISO;
  }
  return new Date(value).toISOString();
}

function decodeLeaderboardCursor(raw: string): { r: string; s: number; i: string } {
  try {
    return decodeCursor(raw, LeaderboardCursor);
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

function decodeKeysetCursor(raw: string): {
  score: number;
  itemId: bigint;
  runId: string | undefined;
} {
  try {
    const cursor = decodeCursor(raw, KeysetCursor);
    const score = typeof cursor.k === 'string' ? Number(cursor.k) : cursor.k;
    if (!Number.isFinite(score) || !/^\d{1,19}$/.test(cursor.i)) {
      throw new Error('malformed cursor');
    }
    return { score, itemId: BigInt(cursor.i), runId: cursor.r };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

function toEntry(row: EntryData, window: Window, rank: number): LeaderboardEntry {
  return {
    rank,
    item: {
      id: String(row.item.id),
      source: row.item.source,
      kind: row.item.kind,
      externalId: row.item.externalId,
      displayName: row.item.displayName,
      description: row.item.description,
      url: row.item.url,
      language: row.item.language,
      topics: row.item.topics,
      primaryMetric: row.item.primaryMetric,
    },
    window,
    delta: row.delta,
    relGrowth: row.relGrowth,
    score: row.score,
    percentile: row.percentile,
    current: row.series.current,
    sparkline: row.series.sparkline,
    flags: row.flags,
  };
}

function parseCard(raw: string | null): LeaderboardCard | null {
  if (raw === null) {
    return null;
  }
  try {
    const parsed = LeaderboardCardSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function fromCard(card: LeaderboardCard): EntryData {
  return {
    item: {
      id: BigInt(card.item.id),
      source: card.item.source,
      kind: card.item.kind,
      externalId: card.item.externalId,
      displayName: card.item.displayName,
      description: card.item.description,
      url: card.item.url,
      language: card.item.language,
      primaryMetric: card.item.primaryMetric,
      topics: card.item.topics,
    },
    series: { current: card.current, sparkline: card.sparkline },
    delta: card.delta,
    relGrowth: card.relGrowth,
    score: card.score,
    percentile: card.percentile,
    flags: card.flags,
  };
}

async function readBoardMeta(
  redis: Redis,
  scope: LeaderboardScope,
  window: Window,
): Promise<BoardMeta | null> {
  const raw = await redis.hgetall(redisKeys.leaderboardMeta(scope, window));
  if (raw.runId === undefined) {
    return null;
  }
  return {
    runId: raw.runId,
    computedAt: toIsoOrEpoch(raw.computedAt),
    version: raw.version ?? '0',
  };
}

async function safeBoardMeta(
  app: FastifyInstance,
  scope: LeaderboardScope,
  window: Window,
): Promise<BoardMeta | null> {
  if (!app.hasDecorator('redis')) {
    return null;
  }
  try {
    return await readBoardMeta(app.redis, scope, window);
  } catch (error) {
    app.log.warn({ err: error }, 'lbmeta read failed; serving from SQL');
    return null;
  }
}

/** `ZREVRANK` for a page of members, already shifted to 1-based ranks. */
async function ranksOf(
  redis: Redis,
  key: string,
  members: readonly string[],
): Promise<(number | null)[]> {
  const pipeline = redis.pipeline();
  for (const member of members) {
    pipeline.zrevrank(key, member);
  }
  const replies = await pipeline.exec();
  if (replies === null) {
    throw new Error('trending: ZREVRANK pipeline aborted');
  }
  return replies.map(([error, value]) => {
    if (error !== null) {
      throw error;
    }
    return typeof value === 'number' ? value + 1 : null;
  });
}

/**
 * Hydrate entries from Postgres (§9.3: cards are only minted for board heads).
 * `useZScore` is false for the Redis path, where cards carry the source score
 * (§2.5 note) — hydration stays consistent with what `card:*` would have held.
 */
async function hydrateEntries(
  app: FastifyInstance,
  scope: LeaderboardScope,
  window: Window,
  ids: readonly bigint[],
  useZScore: boolean,
): Promise<Map<string, EntryData>> {
  const out = new Map<string, EntryData>();
  if (ids.length === 0 || !app.hasDecorator('db')) {
    return out;
  }
  const db = app.db;
  const cardItems = await loadCardItems(db, ids);
  const series = await loadCardSeries(db, cardItems, new Date());
  const rows = await db
    .select({
      itemId: scores.itemId,
      delta: scores.delta,
      relGrowth: scores.relGrowth,
      finalScore: scores.finalScore,
      zScore: scores.zScore,
      percentile: scores.percentile,
      flags: scores.flags,
    })
    .from(scores)
    .innerJoin(
      scoreRunsCurrent,
      and(
        eq(scoreRunsCurrent.source, scores.source),
        eq(scoreRunsCurrent.window, scores.window),
        eq(scoreRunsCurrent.runId, scores.runId),
      ),
    )
    .where(
      and(
        eq(scores.window, window),
        inArray(scores.itemId, [...ids]),
        scope === 'all' ? isNotNull(scores.rankAll) : eq(scores.source, scope),
      ),
    );

  for (const row of rows) {
    const item = cardItems.get(row.itemId);
    const itemSeries = series.get(row.itemId);
    if (item === undefined || itemSeries === undefined) {
      continue;
    }
    out.set(String(row.itemId), {
      item,
      series: itemSeries,
      delta: row.delta,
      relGrowth: row.relGrowth,
      score: useZScore ? row.zScore : row.finalScore,
      percentile: row.percentile,
      flags: row.flags as LeaderboardEntry['flags'],
    });
  }
  return out;
}

async function loadRedisPage(
  app: FastifyInstance,
  query: TrendingQueryInput,
  meta: BoardMeta,
): Promise<TrendingResponseBody> {
  const { scope, window: w, limit } = query;
  const key = redisKeys.leaderboard(scope, w, query.lang ?? '_all');

  let start = 0;
  if (query.cursor !== undefined) {
    const decoded = decodeLeaderboardCursor(query.cursor);
    if (decoded.r !== meta.runId) {
      throw new CursorExpiredError(
        'The leaderboard was rebuilt while this cursor was in use; restart pagination.',
      );
    }
    // Rank-based continuation is tie-safe: equal scores are ordered by member
    // lexicographically, and the cursor member's rank locates the next entry
    // even when the whole page shares one score.
    const cursorRank = await app.redis.zrevrank(key, decoded.i);
    if (cursorRank === null) {
      throw new CursorExpiredError(
        'The leaderboard changed while this cursor was in use; restart pagination.',
      );
    }
    start = cursorRank + 1;
  }

  // Fetch one extra row after the cursor; ranks stay absolute board ranks.
  const raw = await app.redis.zrevrange(key, start, start + limit, 'WITHSCORES');
  const pairs: BoardPair[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const member = raw[i];
    const score = raw[i + 1];
    if (member !== undefined && score !== undefined) {
      pairs.push({ member, score: Number(score) });
    }
  }
  const fetched = pairs.slice(0, limit);
  const hasMore = pairs.length > limit;

  const ranks =
    fetched.length === 0
      ? []
      : await ranksOf(
          app.redis,
          key,
          fetched.map((pair) => pair.member),
        );
  const cards =
    fetched.length === 0
      ? []
      : await app.redis.mget(fetched.map((pair) => redisKeys.card(pair.member, w)));

  const byMember = new Map<string, EntryData>();
  const missing: bigint[] = [];
  fetched.forEach((pair, index) => {
    const card = parseCard(cards[index] ?? null);
    if (card === null) {
      missing.push(BigInt(pair.member));
      return;
    }
    byMember.set(pair.member, fromCard(card));
  });
  if (missing.length > 0) {
    const hydrated = await hydrateEntries(app, scope, w, missing, false);
    for (const [member, row] of hydrated) {
      byMember.set(member, row);
    }
  }

  const data: LeaderboardEntry[] = [];
  fetched.forEach((pair, index) => {
    const row = byMember.get(pair.member);
    if (row === undefined) {
      return;
    }
    data.push(toEntry(row, w, ranks[index] ?? index + 1));
  });

  const last = fetched.at(-1);
  return {
    scope,
    window: w,
    runId: meta.runId,
    computedAt: meta.computedAt,
    data,
    page: {
      nextCursor:
        hasMore && last !== undefined
          ? encodeCursor({ r: meta.runId, s: last.score, i: last.member })
          : null,
      limit,
    },
  };
}

interface SqlScoreRow {
  itemId: bigint;
  delta: number;
  relGrowth: number;
  finalScore: number;
  zScore: number;
  percentile: number;
  flags: string[];
  rankSource: number | null;
  rankAll: number | null;
}

interface BuiltSqlEntry {
  boardScore: number;
  itemId: bigint;
  entry: LeaderboardEntry;
}

async function loadCurrentRunSnapshot(
  db: Db,
  scope: LeaderboardScope,
  window: Window,
): Promise<{
  runId: string;
  computedAt: string;
  runIds: bigint[];
  signature: string;
}> {
  const conditions = [eq(scoreRunsCurrent.window, window)];
  if (scope !== 'all') {
    conditions.push(eq(scoreRunsCurrent.source, scope));
  }
  const rows = await db
    .select({
      source: scoreRunsCurrent.source,
      runId: scoreRunsCurrent.runId,
      computedAt: scoreRunsCurrent.computedAt,
    })
    .from(scoreRunsCurrent)
    .where(and(...conditions))
    .orderBy(desc(scoreRunsCurrent.computedAt), asc(scoreRunsCurrent.source));
  const latest = rows[0];
  if (latest === undefined) {
    return { runId: '0', computedAt: EPOCH_ISO, runIds: [], signature: '0' };
  }
  // A scoped cursor names its source's run. The combined `all` scope spans one
  // current run per source, so its signature is a fingerprint of that set;
  // the captured run ids pin the SQL query even if a swap races the request.
  const signature =
    scope === 'all'
      ? createHash('sha1')
          .update(
            rows
              .map((row) => `${row.source}:${String(row.runId)}`)
              .sort()
              .join('|'),
          )
          .digest('hex')
          .slice(0, 16)
      : String(latest.runId);
  return {
    runId: String(latest.runId),
    computedAt: latest.computedAt.toISOString(),
    runIds: rows.map((row) => row.runId),
    signature,
  };
}

async function buildSqlEntries(
  db: Db,
  window: Window,
  rows: readonly SqlScoreRow[],
  useZScore: boolean,
  minCurrent: number | undefined,
): Promise<BuiltSqlEntry[]> {
  const ids = rows.map((row) => row.itemId);
  const cardItems = await loadCardItems(db, ids);
  const series = await loadCardSeries(db, cardItems, new Date());
  const out: BuiltSqlEntry[] = [];
  for (const row of rows) {
    const item = cardItems.get(row.itemId);
    const itemSeries = series.get(row.itemId);
    const rank = useZScore ? row.rankAll : row.rankSource;
    if (item === undefined || itemSeries === undefined || rank === null) {
      continue;
    }
    // `minCurrent` filters on the same hydrated `current` the response serves,
    // so the caller's top-up loop refetches deeper instead of re-filtering.
    if (minCurrent !== undefined && itemSeries.current < minCurrent) {
      continue;
    }
    const boardScore = useZScore ? row.zScore : row.finalScore;
    out.push({
      boardScore,
      itemId: row.itemId,
      entry: toEntry(
        {
          item,
          series: itemSeries,
          delta: row.delta,
          relGrowth: row.relGrowth,
          score: boardScore,
          percentile: row.percentile,
          flags: row.flags as LeaderboardEntry['flags'],
        },
        window,
        rank,
      ),
    });
  }
  return out;
}

async function querySqlPage(
  app: FastifyInstance,
  query: TrendingQueryInput,
): Promise<TrendingResponseBody> {
  const db = app.db;
  const { scope, window: w, limit } = query;
  const useZScore = scope === 'all';
  const scoreExpr = useZScore ? scores.zScore : scores.finalScore;
  const initialScan = query.cursor === undefined ? undefined : decodeKeysetCursor(query.cursor);
  const run = await loadCurrentRunSnapshot(db, scope, w);
  if (initialScan !== undefined && initialScan.runId !== run.signature) {
    throw new CursorExpiredError(
      'The leaderboard was rebuilt while this cursor was in use; restart pagination.',
    );
  }
  const collected: BuiltSqlEntry[] = [];
  let scan: { score: number; itemId: bigint } | undefined =
    initialScan === undefined
      ? undefined
      : { score: initialScan.score, itemId: initialScan.itemId };

  const conditions = [
    eq(scores.window, w),
    useZScore ? isNotNull(scores.rankAll) : eq(scores.source, scope),
    query.kind === undefined ? undefined : eq(items.kind, query.kind),
    query.newOnly
      ? gte(items.upstreamCreatedAt, new Date(Date.now() - NEW_ITEM_DAYS * DAY_MS))
      : undefined,
    query.lang === undefined || query.lang === '_all'
      ? undefined
      : sql`lower(${items.language}) = ${query.lang}`,
    query.topic === undefined
      ? undefined
      : inArray(
          items.id,
          db
            .select({ itemId: itemTopics.itemId })
            .from(itemTopics)
            .innerJoin(topics, eq(topics.id, itemTopics.topicId))
            .where(eq(topics.slug, query.topic)),
        ),
  ];

  for (;;) {
    const rows = await db
      .select({
        itemId: scores.itemId,
        delta: scores.delta,
        relGrowth: scores.relGrowth,
        finalScore: scores.finalScore,
        zScore: scores.zScore,
        percentile: scores.percentile,
        flags: scores.flags,
        rankSource: scores.rankSource,
        rankAll: scores.rankAll,
      })
      .from(scores)
      .innerJoin(
        scoreRunsCurrent,
        and(
          eq(scoreRunsCurrent.source, scores.source),
          eq(scoreRunsCurrent.window, scores.window),
          eq(scoreRunsCurrent.runId, scores.runId),
        ),
      )
      .innerJoin(items, eq(items.id, scores.itemId))
      .where(
        and(
          ...conditions,
          run.runIds.length === 0 ? sql`false` : inArray(scores.runId, run.runIds),
          scan === undefined
            ? undefined
            : or(
                lt(scoreExpr, scan.score),
                and(eq(scoreExpr, scan.score), lt(scores.itemId, scan.itemId)),
              ),
        ),
      )
      .orderBy(desc(scoreExpr), desc(scores.itemId))
      .limit(limit + 1);

    if (rows.length === 0) {
      break;
    }

    const batch = await buildSqlEntries(db, w, rows, useZScore, query.minCurrent);
    for (const built of batch) {
      if (collected.length < limit + 1) {
        collected.push(built);
      }
    }

    // The scan always advances past the whole batch, so rows filtered out by
    // `minCurrent` (or missing a series) cannot resurface forever.
    const lastRow = rows[rows.length - 1];
    if (lastRow !== undefined) {
      scan = { score: useZScore ? lastRow.zScore : lastRow.finalScore, itemId: lastRow.itemId };
    }

    if (collected.length > limit || rows.length < limit + 1) {
      break;
    }
  }

  const hasMore = collected.length > limit;
  const page = hasMore ? collected.slice(0, limit) : collected;
  const lastReturned = page.at(-1);
  return {
    scope,
    window: w,
    runId: run.runId,
    computedAt: run.computedAt,
    data: page.map((built) => built.entry),
    page: {
      nextCursor:
        hasMore && lastReturned !== undefined
          ? encodeCursor({
              r: run.signature,
              k: lastReturned.boardScore,
              i: String(lastReturned.itemId),
            })
          : null,
      limit,
    },
  };
}

async function loadSqlPage(
  app: FastifyInstance,
  query: TrendingQueryInput,
): Promise<TrendingResponseBody> {
  const load = (): Promise<TrendingResponseBody> => querySqlPage(app, query);
  if (!app.hasDecorator('cache')) {
    return load();
  }
  return app.cache.readThrough(
    redisKeys.queryCache(canonicalQuery(query)),
    QUERY_CACHE_TTL_SECONDS,
    load,
    'query',
  );
}

export function registerTrendingRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/trending',
    {
      config: { cacheControl: CACHE_CONTROL.publicLong },
      schema: {
        querystring: TrendingQuery,
        response: { 200: TrendingResponse },
      },
    },
    async (request, reply) => {
      const query = request.query;

      // Spec §10.5: pages with a next cursor carry `Link: <...>; rel="next"`.
      const withNextLink = (body: TrendingResponseBody): TrendingResponseBody => {
        if (body.page.nextCursor !== null) {
          reply.header(
            'link',
            nextLinkHeader(
              `${request.protocol}://${request.host}`,
              request.url,
              body.page.nextCursor,
            ),
          );
        }
        return body;
      };

      const meta = await safeBoardMeta(app, query.scope, query.window);
      if (meta !== null) {
        const etag = trendingEtag(query.scope, query.window, meta.version, query);
        reply.header('etag', etag);
        if (ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
          // The provider-typed reply only exposes the schema's 200; a 304 is a
          // bodiless reply (`send()` skips serialization entirely).
          return (reply as FastifyReply).code(304).send();
        }
      }

      const breakerOpen = app.hasDecorator('cache') && app.cache.breakerState().open;
      const boardCandidate =
        !hasSqlFilters(query) &&
        (query.lang === undefined || query.lang === '_all') &&
        !breakerOpen;
      if (meta !== null && boardCandidate) {
        try {
          const body = await loadRedisPage(app, query, meta);
          if (app.hasDecorator('observeCache')) app.observeCache('leaderboard', 'hit');
          return withNextLink(body);
        } catch (error) {
          if (error instanceof AppError) {
            throw error;
          }
          if (app.hasDecorator('observeCache')) app.observeCache('leaderboard', 'miss');
          request.log.warn({ err: error }, 'redis trending read failed; degrading to SQL');
        }
      } else if (meta === null && boardCandidate && app.hasDecorator('observeCache')) {
        app.observeCache('leaderboard', 'miss');
      }
      return withNextLink(await loadSqlPage(app, query));
    },
  );
}
