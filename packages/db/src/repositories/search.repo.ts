import { and, asc, desc, eq, gte, isNotNull, sql, type SQL } from 'drizzle-orm';

import { SOURCES, type ItemKind, type Metric, type Source } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { itemTopics, items, topics } from '../schema/items.js';
import { ingestionRuns } from '../schema/ops.js';
import type { JobType } from './runs.repo.js';

/**
 * Task 3.4 read paths (spec §10.1, §10.5): Postgres FTS over `search_tsv` with
 * the pg_trgm fallback (spec §7.5), newly discovered items, the topic/language
 * lists and the public stats snapshot.
 *
 * `search_tsv` mixes configs — names with `simple` (weight A), descriptions
 * with `english` (weight B) — so both `websearch_to_tsquery` forms are queried
 * and the better of the two ranks is kept; either config may be the one that
 * matches. The trigram fallback compares `lower(display_name)` against the raw
 * query with `word_similarity(...) > 0`: the measured similarity for the §18
 * acceptance pair (`nxt` → `vercel/next.js`) is ≈ 0.29, below pg_trgm's
 * operator thresholds (0.3 for `%`, 0.6 for `<%`), so the function form is
 * required. It is a sequential scan by design (a fraction of `items`, only
 * running when FTS found fewer than 5 hits).
 */

/** The list-item fields shared by `/v1/search` and `/v1/new` (spec §11.1 `search_items`). */
export interface ItemSummaryRow {
  id: bigint;
  source: Source;
  kind: ItemKind;
  name: string;
  displayName: string;
  description: string | null;
  url: string;
  upstreamCreatedAt: Date | null;
  primaryMetric: Metric;
  latestMetrics: Partial<Record<string, number>>;
  score7d: number | null;
}

export interface ScoredItemSummaryRow extends ItemSummaryRow {
  score: number;
}

export interface SearchParams {
  q: string;
  source?: Source | undefined;
  kind?: ItemKind | undefined;
  /** SQL LIMIT — callers pass page size + 1 to detect a next page. */
  fetch: number;
  /** Keyset position: strictly after this (score, itemId) pair. */
  after?: { score: number; itemId: bigint } | undefined;
}

export interface FtsSearchPage {
  rows: ScoredItemSummaryRow[];
  /**
   * Number of FTS matches (`count(*) OVER ()`), which on pages deeper than
   * the first only counts the rows at/below the cursor — callers read it on
   * the first page to pick the search mode.
   */
  total: number;
}

/** Summary columns every query in this module returns. */
function summaryColumns() {
  return {
    id: items.id,
    source: items.source,
    kind: items.kind,
    name: items.name,
    displayName: items.displayName,
    description: items.description,
    url: items.url,
    upstreamCreatedAt: items.upstreamCreatedAt,
    primaryMetric: items.primaryMetric,
    latestMetrics: items.latestMetrics,
    score7d: sql<number | null>`(
      SELECT s.final_score
      FROM scores s
      JOIN score_runs_current src
        ON src.source = s.source AND src.window = s.window AND src.run_id = s.run_id
      WHERE s.item_id = ${items.id} AND s.window = '7d'
    )`,
  };
}

function toScoredSummaryRow(row: {
  id: bigint;
  source: Source;
  kind: ItemKind;
  name: string;
  displayName: string;
  description: string | null;
  url: string;
  upstreamCreatedAt: Date | null;
  primaryMetric: Metric;
  latestMetrics: Partial<Record<string, number>>;
  score7d: number | null;
  score: number;
}): ScoredItemSummaryRow {
  return {
    id: row.id,
    source: row.source,
    kind: row.kind,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    url: row.url,
    upstreamCreatedAt: row.upstreamCreatedAt,
    primaryMetric: row.primaryMetric,
    latestMetrics: row.latestMetrics,
    score7d: row.score7d,
    score: row.score,
  };
}

/** The FTS predicates shared by the match itself and the trigram exclusion. */
function ftsExpressions(q: string): { matches: SQL; rank: SQL<number> } {
  const qEng = sql`websearch_to_tsquery('english', ${q})`;
  const qSim = sql`websearch_to_tsquery('simple', ${q})`;
  return {
    matches: sql`(${items.searchTsv} @@ ${qEng} OR ${items.searchTsv} @@ ${qSim})`,
    rank: sql<number>`greatest(ts_rank_cd(${items.searchTsv}, ${qEng}), ts_rank_cd(${items.searchTsv}, ${qSim}))`,
  };
}

/**
 * Spec §10.1 `/v1/search` primary path: full-text matches ordered by
 * `ts_rank_cd` (best config wins), keyset-paginated on `(rank, id)`.
 */
export async function searchItemsFts(db: DbExecutor, params: SearchParams): Promise<FtsSearchPage> {
  const { matches, rank } = ftsExpressions(params.q);
  const conditions: (SQL | undefined)[] = [
    eq(items.isDeleted, false),
    sql`${matches}`,
    params.source === undefined ? undefined : eq(items.source, params.source),
    params.kind === undefined ? undefined : eq(items.kind, params.kind),
    params.after === undefined
      ? undefined
      : sql`(${rank} < ${params.after.score} OR (${rank} = ${params.after.score} AND ${items.id} < ${params.after.itemId}))`,
  ];

  const rows = await db
    .select({
      ...summaryColumns(),
      score: rank.as('score'),
      total: sql<number>`(count(*) OVER ())::int`.as('total'),
    })
    .from(items)
    .where(and(...conditions))
    .orderBy(desc(rank), desc(items.id))
    .limit(params.fetch);

  return {
    rows: rows.map(toScoredSummaryRow),
    total: rows[0]?.total ?? 0,
  };
}

/**
 * Spec §10.1 `/v1/search` fallback: items that do *not* full-text match but
 * are trigram-similar on `display_name`, ordered by similarity, keyset-
 * paginated on `(similarity, id)`.
 */
export async function searchItemsTrigram(
  db: DbExecutor,
  params: SearchParams,
): Promise<ScoredItemSummaryRow[]> {
  const { matches } = ftsExpressions(params.q);
  const sim = sql<number>`word_similarity(lower(${params.q}), lower(${items.displayName}))`;
  const conditions: (SQL | undefined)[] = [
    eq(items.isDeleted, false),
    sql`NOT ${matches}`,
    sql`${sim} > 0`,
    params.source === undefined ? undefined : eq(items.source, params.source),
    params.kind === undefined ? undefined : eq(items.kind, params.kind),
    params.after === undefined
      ? undefined
      : sql`(${sim} < ${params.after.score} OR (${sim} = ${params.after.score} AND ${items.id} < ${params.after.itemId}))`,
  ];

  const rows = await db
    .select({
      ...summaryColumns(),
      score: sim.as('score'),
    })
    .from(items)
    .where(and(...conditions))
    .orderBy(desc(sim), desc(items.id))
    .limit(params.fetch);

  return rows.map(toScoredSummaryRow);
}

export interface NewItemsParams {
  source?: Source | undefined;
  kind?: ItemKind | undefined;
  /** Items with `upstream_created_at >= since` (UTC comparison). */
  since: Date;
  /** SQL LIMIT — callers pass the fixed page size + 1. */
  fetch: number;
  after?: { createdAt: Date; itemId: bigint } | undefined;
}

/**
 * Spec §10.1 `/v1/new`: live items discovered upstream within the window,
 * newest first. Items without an `upstream_created_at` cannot be placed on
 * the timeline and are excluded (the `>=` comparison drops them anyway).
 */
export async function listNewItems(
  db: DbExecutor,
  params: NewItemsParams,
): Promise<ItemSummaryRow[]> {
  const conditions: (SQL | undefined)[] = [
    eq(items.isDeleted, false),
    isNotNull(items.upstreamCreatedAt),
    gte(items.upstreamCreatedAt, params.since),
    params.source === undefined ? undefined : eq(items.source, params.source),
    params.kind === undefined ? undefined : eq(items.kind, params.kind),
    params.after === undefined
      ? undefined
      : sql`(${items.upstreamCreatedAt} < ${params.after.createdAt} OR (${items.upstreamCreatedAt} = ${params.after.createdAt} AND ${items.id} < ${params.after.itemId}))`,
  ];

  const rows = await db
    .select(summaryColumns())
    .from(items)
    .where(and(...conditions))
    .orderBy(desc(items.upstreamCreatedAt), desc(items.id))
    .limit(params.fetch);

  return rows.map((row) => ({ ...row }));
}

export interface TopicListItem {
  slug: string;
  name: string;
  itemCount: number;
}

/**
 * Spec §10.1 `/v1/topics`: live per-topic item counts (the denormalized
 * `topics.item_count` column cannot answer the `source` filter and ignores
 * soft deletes), most items first.
 */
export async function listTopics(
  db: DbExecutor,
  params: { source?: Source | undefined; limit: number },
): Promise<TopicListItem[]> {
  return db
    .select({
      slug: topics.slug,
      name: topics.name,
      itemCount: sql<number>`count(*)::int`,
    })
    .from(itemTopics)
    .innerJoin(topics, eq(topics.id, itemTopics.topicId))
    .innerJoin(items, eq(items.id, itemTopics.itemId))
    .where(
      and(
        eq(items.isDeleted, false),
        params.source === undefined ? undefined : eq(items.source, params.source),
      ),
    )
    .groupBy(topics.id, topics.slug, topics.name)
    .orderBy(desc(sql`count(*)`), asc(topics.name), asc(topics.slug))
    .limit(params.limit);
}

export interface LanguageListItem {
  language: string;
  itemCount: number;
}

/**
 * Spec §10.1 `/v1/languages`: the §9.1 language-board candidates — the most
 * common languages across live items (boards themselves arrive in Phase 6).
 */
export async function listLanguages(db: DbExecutor, limit: number): Promise<LanguageListItem[]> {
  const rows = await db
    .select({ language: items.language, itemCount: sql<number>`count(*)::int` })
    .from(items)
    .where(and(eq(items.isDeleted, false), isNotNull(items.language)))
    .groupBy(items.language)
    .orderBy(desc(sql`count(*)`), asc(items.language))
    .limit(limit);

  return rows.flatMap((row) =>
    row.language === null ? [] : [{ language: row.language, itemCount: row.itemCount }],
  );
}

export interface StatsRun {
  source: Source | null;
  jobType: JobType;
  runId: bigint;
  lastSuccessAt: Date;
}

export interface StatsSnapshot {
  /** Live item counts; every §5 source is present, zero-filled. */
  items: Record<Source, number>;
  /** The latest succeeded run per (source, job type); cross-source jobs carry `null`. */
  runs: StatsRun[];
}

/** Raw `db.execute` bypasses drizzle's column mappers; normalize both shapes. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

/** Spec §10.1 `/v1/stats`: item counts per source and the last success per job. */
export async function loadStats(db: DbExecutor): Promise<StatsSnapshot> {
  const [countRows, runRows] = await Promise.all([
    db
      .select({ source: items.source, itemCount: sql<number>`count(*)::int` })
      .from(items)
      .where(eq(items.isDeleted, false))
      .groupBy(items.source),
    db.execute<{
      source: Source | null;
      jobType: JobType;
      runId: string;
      lastSuccessAt: Date | string;
    }>(sql`
      SELECT DISTINCT ON (source, job_type)
             source, job_type AS "jobType", id::text AS "runId", finished_at AS "lastSuccessAt"
      FROM ${ingestionRuns}
      WHERE status = 'succeeded' AND finished_at IS NOT NULL
      ORDER BY source, job_type, finished_at DESC, id DESC`),
  ]);

  const counts = Object.fromEntries(SOURCES.map((source) => [source, 0])) as Record<Source, number>;
  for (const row of countRows) {
    counts[row.source] = row.itemCount;
  }

  return {
    items: counts,
    runs: runRows.rows.map((row) => ({
      source: row.source,
      jobType: row.jobType,
      runId: BigInt(row.runId),
      lastSuccessAt: toDate(row.lastSuccessAt),
    })),
  };
}
