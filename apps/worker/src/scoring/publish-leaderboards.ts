import { and, asc, desc, eq, gt, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  ALL_BOARD_TOP_N,
  LEADERBOARD_EVENTS_CHANNEL,
  LB_MAX_SIZE,
  LeaderboardCardSchema,
  LeaderboardUpdatedEventSchema,
  redisKeys,
  type ItemKind,
  type LeaderboardScope,
  type LeaderboardUpdatedEvent,
  type Metric,
  type Source,
  type Window,
} from '@trendr/core';
import {
  dailyMetrics,
  itemTopics,
  items,
  scoreRunsCurrent,
  scores,
  topics,
  type Db,
} from '@trendr/db';

/**
 * Spec §9.2 — publish leaderboards. Every board is built in a throwaway
 * `lb:{scope}:{window}:{lang}:tmp:{runId}` ZSET and swapped in with RENAME
 * inside one MULTI, so a concurrent reader sees the old board or the new one,
 * never a partial fill. Cards travel in the pre-swap pipeline (MSET + per-key
 * EXPIRE); the diff events go to `events:leaderboard` only after every board
 * of the run has been swapped (spec §9.2 tail).
 */

const ZADD_CHUNK = 500;
const MSET_CHUNK = 50;
const CARD_TTL_SECONDS = 6 * 3600;
const TMP_TTL_SECONDS = 600;
/** Cards and the mover diff cover the top of each board (spec §9.2 "top 100"). */
export const CARD_LIMIT = 100;
const MOVER_LIMIT = 20;
const DAY_MS = 86_400_000;
/** Daily sparkline points per card ("up to 30 points", spec §5). */
const SPARKLINE_POINTS = 30;

interface BoardRow {
  itemId: bigint;
  /** Board score: `final_score` for source boards, `z_score` for the combined board (§9.1). */
  score: number;
  /** Window growth (`scores.delta`); travels in the mover payload (§9.2 example). */
  delta?: number;
}

interface BoardCard {
  itemId: bigint;
  /** Serialized `LeaderboardCard` for `card:{itemId}:{window}`. */
  json: string;
}

export interface PublishBoardOptions {
  /** `card:{itemId}:{window}` payloads written before the swap (spec §9.2). */
  cards?: readonly BoardCard[];
  /** Run instant for `lbmeta` and the diff; defaults to now. */
  computedAt?: Date;
}

type PipelineReply = [error: Error | null, value: unknown];

function readReply(entry: PipelineReply | undefined, command: string): unknown {
  if (entry === undefined) throw new Error(`publishBoard: missing ${command} reply`);
  const [error, value] = entry;
  if (error !== null) throw error;
  return value;
}

function toStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((member) => String(member));
}

/**
 * Rebuild one board. `rows` must already be sorted by descending score (the
 * caller reads them from `scores`); the first `LB_MAX_SIZE` rows become the
 * ZSET members. Returns the §9.2 diff so the caller can publish it once every
 * board of the run is swapped.
 */
export async function publishBoard(
  redis: Redis,
  scope: LeaderboardScope,
  w: Window,
  lang: string,
  rows: readonly BoardRow[],
  runId: bigint,
  options: PublishBoardOptions = {},
): Promise<LeaderboardUpdatedEvent> {
  const live = redisKeys.leaderboard(scope, w, lang);
  const tmp = `${live}:tmp:${runId}`;
  const top = rows.slice(0, LB_MAX_SIZE);
  const head = top.slice(0, CARD_LIMIT);
  const computedAt = options.computedAt ?? new Date();
  const cards = options.cards ?? [];

  // The previous board must be sampled before the swap: old top-100
  // membership separates entered/exited and ZREVRANK feeds prevRank (§9.2).
  const before = redis.pipeline();
  before.zrevrange(live, 0, CARD_LIMIT - 1);
  for (const row of head) before.zrevrank(live, String(row.itemId));
  const beforeReplies = await before.exec();
  if (beforeReplies === null) throw new Error(`publishBoard: read pipeline aborted for ${live}`);

  const previousTop = toStrings(readReply(beforeReplies[0], 'ZREVRANGE'));
  const previousRanks = new Map<bigint, number>();
  head.forEach((row, index) => {
    const rank = readReply(beforeReplies[index + 1], 'ZREVRANK');
    if (typeof rank === 'number') previousRanks.set(row.itemId, rank + 1);
  });

  const builder = redis.pipeline();
  builder.del(tmp);
  for (let i = 0; i < top.length; i += ZADD_CHUNK) {
    const chunk = top.slice(i, i + ZADD_CHUNK);
    builder.zadd(tmp, ...chunk.flatMap((row) => [row.score, String(row.itemId)]));
  }
  builder.expire(tmp, TMP_TTL_SECONDS);

  for (let i = 0; i < cards.length; i += MSET_CHUNK) {
    const chunk = cards.slice(i, i + MSET_CHUNK);
    builder.mset(...chunk.flatMap((card) => [redisKeys.card(card.itemId, w), card.json]));
  }
  for (const card of cards) builder.expire(redisKeys.card(card.itemId, w), CARD_TTL_SECONDS);

  const crafted = await builder.exec();
  if (crafted === null) throw new Error(`publishBoard: build pipeline aborted for ${live}`);

  const meta = redisKeys.leaderboardMeta(scope, w);
  const swap = redis.multi();
  // An empty board must delete the key: RENAME of a missing key errors (§9.2).
  if (top.length > 0) swap.rename(tmp, live);
  else swap.del(live);
  swap
    .expire(live, CARD_TTL_SECONDS)
    .hset(meta, {
      runId: String(runId),
      computedAt: computedAt.toISOString(),
      count: String(top.length),
    })
    .hincrby(meta, 'version', 1);
  const swapped = await swap.exec();
  if (swapped === null) throw new Error(`publishBoard: swap aborted for ${live}`);

  const previousTopSet = new Set(previousTop);
  const newTopSet = new Set(head.map((row) => String(row.itemId)));
  const entered = [...newTopSet].filter((itemId) => !previousTopSet.has(itemId));
  const exited = previousTop.filter((itemId) => !newTopSet.has(itemId));

  const movers: { itemId: string; rank: number; prevRank: number; delta: number }[] = [];
  head.forEach((row, index) => {
    const prevRank = previousRanks.get(row.itemId);
    const rank = index + 1;
    if (prevRank === undefined || prevRank > CARD_LIMIT || prevRank === rank) return;
    movers.push({ itemId: String(row.itemId), rank, prevRank, delta: row.delta ?? 0 });
  });
  movers.sort(
    (a, b) => Math.abs(b.rank - b.prevRank) - Math.abs(a.rank - a.prevRank) || a.rank - b.rank,
  );

  return LeaderboardUpdatedEventSchema.parse({
    type: 'leaderboard.updated',
    scope,
    window: w,
    runId: String(runId),
    computedAt: computedAt.toISOString(),
    movers: movers.slice(0, MOVER_LIMIT),
    entered,
    exited,
  });
}

export interface PublishDeps {
  db: Db;
  redis: Redis;
}

export interface PublishLeaderboardsOptions {
  /** Scoring instant; recorded in every `lbmeta` and diff event. Defaults to now. */
  computedAt?: Date;
  /** Rows per board that get a `card:` materialization. Defaults to 100. */
  cardLimit?: number;
}

interface ScoreBoardRow {
  itemId: bigint;
  delta: number;
  relGrowth: number;
  finalScore: number;
  zScore: number;
  percentile: number;
  flags: string[];
  rankAll: number | null;
}

interface PreparedWindow {
  window: Window;
  sourceRows: ScoreBoardRow[];
  allRows: ScoreBoardRow[];
}

const SCORE_COLUMNS = {
  itemId: scores.itemId,
  delta: scores.delta,
  relGrowth: scores.relGrowth,
  finalScore: scores.finalScore,
  zScore: scores.zScore,
  percentile: scores.percentile,
  flags: scores.flags,
  rankAll: scores.rankAll,
} as const;

interface CardItem {
  id: bigint;
  source: Source;
  kind: ItemKind;
  externalId: string;
  displayName: string;
  description: string | null;
  url: string;
  language: string | null;
  primaryMetric: Metric;
  topics: string[];
}

interface CardSeries {
  current: number;
  sparkline: number[];
}

/**
 * Spec §8.4 / §9.2 — publish the source boards of a scoring run plus the
 * combined board, then fan out one diff event per board. Rows come from the
 * run's own `scores` (source boards, ordered by `final_score`) and from every
 * source's current run (`rank_all`, scored by `z_score`).
 */
export async function publishLeaderboards(
  deps: PublishDeps,
  source: Source,
  windows: readonly Window[],
  runId: bigint,
  options: PublishLeaderboardsOptions = {},
): Promise<LeaderboardUpdatedEvent[]> {
  const computedAt = options.computedAt ?? new Date();
  const cardLimit = options.cardLimit ?? CARD_LIMIT;
  if (windows.length === 0) return [];

  const prepared: PreparedWindow[] = [];
  const cardIds = new Set<bigint>();

  for (const w of windows) {
    const sourceRows = await deps.db
      .select(SCORE_COLUMNS)
      .from(scores)
      .where(and(eq(scores.source, source), eq(scores.window, w), eq(scores.runId, runId)))
      .orderBy(desc(scores.finalScore), asc(scores.itemId))
      .limit(LB_MAX_SIZE);

    const allRows = await deps.db
      .select(SCORE_COLUMNS)
      .from(scores)
      .innerJoin(
        scoreRunsCurrent,
        and(
          eq(scoreRunsCurrent.source, scores.source),
          eq(scoreRunsCurrent.window, scores.window),
          eq(scoreRunsCurrent.runId, scores.runId),
        ),
      )
      .where(and(eq(scores.window, w), isNotNull(scores.rankAll)))
      .orderBy(asc(scores.rankAll))
      .limit(ALL_BOARD_TOP_N);

    for (const row of sourceRows.slice(0, cardLimit)) cardIds.add(row.itemId);
    for (const row of allRows.slice(0, cardLimit)) cardIds.add(row.itemId);
    prepared.push({ window: w, sourceRows, allRows });
  }

  const cardItems = await loadCardItems(deps.db, [...cardIds]);
  const series = await loadCardSeries(deps.db, cardItems, computedAt);

  const updates: LeaderboardUpdatedEvent[] = [];
  for (const { window: w, sourceRows, allRows } of prepared) {
    // Cards cover the union of both boards' heads; they carry the source score
    // (see docs/SPEC_REVIEW.md "Task 2.5 notes").
    const cards: BoardCard[] = [];
    const seen = new Set<bigint>();
    for (const row of [...sourceRows.slice(0, cardLimit), ...allRows.slice(0, cardLimit)]) {
      if (seen.has(row.itemId)) continue;
      const item = cardItems.get(row.itemId);
      const metric = series.get(row.itemId);
      if (item === undefined || metric === undefined) continue;
      seen.add(row.itemId);
      const card = LeaderboardCardSchema.parse({
        item: {
          id: String(item.id),
          source: item.source,
          kind: item.kind,
          externalId: item.externalId,
          displayName: item.displayName,
          description: item.description,
          url: item.url,
          language: item.language,
          topics: item.topics,
          primaryMetric: item.primaryMetric,
        },
        window: w,
        delta: row.delta,
        relGrowth: row.relGrowth,
        score: row.finalScore,
        percentile: row.percentile,
        current: metric.current,
        sparkline: metric.sparkline,
        flags: row.flags,
      });
      cards.push({ itemId: row.itemId, json: JSON.stringify(card) });
    }

    updates.push(
      await publishBoard(
        deps.redis,
        source,
        w,
        '_all',
        sourceRows.map((row) => ({
          itemId: row.itemId,
          score: row.finalScore,
          delta: row.delta,
        })),
        runId,
        { cards, computedAt },
      ),
    );

    updates.push(
      await publishBoard(
        deps.redis,
        'all',
        w,
        '_all',
        allRows.map((row) => ({ itemId: row.itemId, score: row.zScore, delta: row.delta })),
        runId,
        { computedAt },
      ),
    );
  }

  for (const update of updates) {
    await deps.redis.publish(LEADERBOARD_EVENTS_CHANNEL, JSON.stringify(update));
  }

  return updates;
}

async function loadCardItems(db: Db, ids: readonly bigint[]): Promise<Map<bigint, CardItem>> {
  if (ids.length === 0) return new Map();

  const rows = await db
    .select({
      id: items.id,
      source: items.source,
      kind: items.kind,
      externalId: items.externalId,
      displayName: items.displayName,
      description: items.description,
      url: items.url,
      language: items.language,
      primaryMetric: items.primaryMetric,
    })
    .from(items)
    .where(inArray(items.id, [...ids]));

  const topicRows = await db
    .select({ itemId: itemTopics.itemId, slug: topics.slug })
    .from(itemTopics)
    .innerJoin(topics, eq(topics.id, itemTopics.topicId))
    .where(inArray(itemTopics.itemId, [...ids]))
    .orderBy(asc(topics.slug));

  const topicsByItem = new Map<bigint, string[]>();
  for (const row of topicRows) {
    const list = topicsByItem.get(row.itemId) ?? [];
    list.push(row.slug);
    topicsByItem.set(row.itemId, list);
  }

  return new Map(rows.map((row) => [row.id, { ...row, topics: topicsByItem.get(row.id) ?? [] }]));
}

/**
 * `current` and `sparkline` for each card: the last value per UTC day of the
 * item's primary metric, up to 30 points, oldest first. Cumulative metrics
 * read `snapshots` (the latest day may be partial via the hourly tail);
 * daily-count metrics read `daily_metrics` and stop at the last complete day,
 * matching the §8.4 scoring population.
 */
async function loadCardSeries(
  db: Db,
  cardItems: Map<bigint, CardItem>,
  t: Date,
): Promise<Map<bigint, CardSeries>> {
  const cumulativeIds: bigint[] = [];
  const downloadsIds: bigint[] = [];
  for (const item of cardItems.values()) {
    if (item.primaryMetric === 'downloads') downloadsIds.push(item.id);
    else cumulativeIds.push(item.id);
  }

  const series = new Map<bigint, CardSeries>();

  if (cumulativeIds.length > 0) {
    const since = new Date(t.getTime() - (SPARKLINE_POINTS + 1) * DAY_MS);
    const result = await db.execute<{ itemId: string; value: string; capturedAt: Date | string }>(
      sql`
      SELECT s.item_id::text AS "itemId", s.value::text AS value, s.captured_at AS "capturedAt"
      FROM snapshots s
      WHERE s.item_id IN (${sql.join(
        cumulativeIds.map((itemId) => sql`${itemId}`),
        sql`, `,
      )})
        AND s.captured_at > ${since} AND s.captured_at <= ${t}
      ORDER BY s.item_id, s.captured_at`,
    );

    const byItem = new Map<bigint, Map<string, number>>();
    for (const row of result.rows) {
      const itemId = BigInt(row.itemId);
      const day = new Date(row.capturedAt).toISOString().slice(0, 10);
      const days = byItem.get(itemId) ?? new Map<string, number>();
      days.set(day, Number(row.value));
      byItem.set(itemId, days);
    }
    for (const [itemId, days] of byItem) {
      const values = [...days.keys()]
        .sort()
        .slice(-SPARKLINE_POINTS)
        .map((day) => days.get(day) ?? 0);
      const current = values.at(-1);
      if (current !== undefined) series.set(itemId, { current, sparkline: values });
    }
  }

  if (downloadsIds.length > 0) {
    const since = new Date(t.getTime() - (SPARKLINE_POINTS + 1) * DAY_MS)
      .toISOString()
      .slice(0, 10);
    const today = t.toISOString().slice(0, 10);
    const rows = await db
      .select({ itemId: dailyMetrics.itemId, value: dailyMetrics.value })
      .from(dailyMetrics)
      .innerJoin(items, eq(items.id, dailyMetrics.itemId))
      .where(
        and(
          inArray(dailyMetrics.itemId, downloadsIds),
          eq(dailyMetrics.metric, items.primaryMetric),
          gt(dailyMetrics.day, since),
          lt(dailyMetrics.day, today),
        ),
      )
      .orderBy(asc(dailyMetrics.itemId), asc(dailyMetrics.day));

    const byItem = new Map<bigint, number[]>();
    for (const row of rows) {
      const values = byItem.get(row.itemId) ?? [];
      values.push(row.value);
      byItem.set(row.itemId, values);
    }
    for (const [itemId, values] of byItem) {
      const sparkline = values.slice(-SPARKLINE_POINTS);
      const current = sparkline.at(-1);
      if (current !== undefined) series.set(itemId, { current, sparkline });
    }
  }

  return series;
}
