import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import { SOURCES, type Source } from '@trendr/core';
import { items, loadCardItems, scoreRunsCurrent, scores, type Db } from '@trendr/db';

/**
 * Spec §13.2 — digest content is computed once per UTC day and cached in
 * Redis for 24 h: top 10 per source (7d), top 5 All, top 5 new MCP entries and
 * top 5 arXiv papers by HF upvotes. Personalization (subscribed sources/topics
 * and the user's watchlist) happens in `send-digest`.
 */

export const DIGEST_TOP_SOURCE = 10;
export const DIGEST_TOP_ALL = 5;
const DIGEST_TTL_SECONDS = 24 * 3600;
const WEEK_MS = 7 * 86_400_000;

export interface DigestItem {
  id: string;
  source: Source;
  displayName: string;
  description: string | null;
  url: string;
  language: string | null;
  topics: string[];
  delta: number;
  relGrowth: number;
  percentile: number;
  rank: number;
  previousRank: number | null;
}

export interface DigestContent {
  date: string;
  all: DigestItem[];
  sources: Partial<Record<Source, DigestItem[]>>;
  mcpNew: DigestItem[];
  papers: DigestItem[];
}

export function digestContentKey(date: string): string {
  return `digest:content:${date}`;
}

interface ScoreItemRow {
  itemId: bigint;
  delta: number;
  relGrowth: number;
  percentile: number;
  rank: number | null;
}

async function sourceBoard(db: Db, source: Source, limit: number): Promise<ScoreItemRow[]> {
  return db
    .select({
      itemId: scores.itemId,
      delta: scores.delta,
      relGrowth: scores.relGrowth,
      percentile: scores.percentile,
      rank: scores.rankSource,
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
    .where(and(eq(scores.source, source), eq(scores.window, '7d')))
    .orderBy(scores.rankSource)
    .limit(limit);
}

async function allBoard(db: Db, limit: number): Promise<ScoreItemRow[]> {
  return db
    .select({
      itemId: scores.itemId,
      delta: scores.delta,
      relGrowth: scores.relGrowth,
      percentile: scores.percentile,
      rank: scores.rankAll,
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
    .where(and(eq(scores.window, '7d'), isNotNull(scores.rankAll)))
    .orderBy(scores.rankAll)
    .limit(limit);
}

async function mapItems(db: Db, rows: readonly ScoreItemRow[]): Promise<DigestItem[]> {
  const cards = await loadCardItems(
    db,
    rows.map((row) => row.itemId),
  );
  const result: DigestItem[] = [];
  rows.forEach((row, index) => {
    const card = cards.get(row.itemId);
    if (card === undefined) return;
    result.push({
      id: card.id.toString(),
      source: card.source,
      displayName: card.displayName,
      description: card.description,
      url: card.url,
      language: card.language,
      topics: card.topics,
      delta: row.delta,
      relGrowth: row.relGrowth,
      percentile: row.percentile,
      rank: row.rank ?? index + 1,
      previousRank: null,
    });
  });
  return result;
}

async function mcpNewItems(db: Db, now: Date): Promise<DigestItem[]> {
  const rows = await db
    .select({
      id: items.id,
      source: items.source,
      displayName: items.displayName,
      description: items.description,
      url: items.url,
      language: items.language,
    })
    .from(items)
    .where(
      and(
        eq(items.source, 'mcp'),
        eq(items.isDeleted, false),
        gte(items.firstSeenAt, new Date(now.getTime() - WEEK_MS)),
      ),
    )
    .orderBy(desc(items.firstSeenAt))
    .limit(DIGEST_TOP_ALL);
  const cards = await loadCardItems(
    db,
    rows.map((row) => row.id),
  );

  return rows.map((row, index) => ({
    id: row.id.toString(),
    source: row.source,
    displayName: row.displayName,
    description: row.description,
    url: row.url,
    language: row.language,
    topics: cards.get(row.id)?.topics ?? [],
    delta: 0,
    relGrowth: 0,
    percentile: 0,
    rank: index + 1,
    previousRank: null,
  }));
}

async function paperItems(db: Db): Promise<DigestItem[]> {
  const rows = await db
    .select({
      itemId: scores.itemId,
      delta: scores.delta,
      relGrowth: scores.relGrowth,
      percentile: scores.percentile,
      displayName: items.displayName,
      description: items.description,
      url: items.url,
      language: items.language,
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
    .where(and(eq(scores.source, 'arxiv'), eq(scores.window, '7d')))
    .orderBy(sql`coalesce((${items.latestMetrics} ->> 'upvotes')::bigint, 0) DESC`)
    .limit(DIGEST_TOP_ALL);
  const cards = await loadCardItems(
    db,
    rows.map((row) => row.itemId),
  );

  return rows.map((row, index) => ({
    id: row.itemId.toString(),
    source: 'arxiv',
    displayName: row.displayName,
    description: row.description,
    url: row.url,
    language: row.language,
    topics: cards.get(row.itemId)?.topics ?? [],
    delta: row.delta,
    relGrowth: row.relGrowth,
    percentile: row.percentile,
    rank: index + 1,
    previousRank: null,
  }));
}

export async function buildDigestContent(
  db: Db,
  redis: Redis,
  now: Date,
  force = false,
): Promise<DigestContent> {
  const date = now.toISOString().slice(0, 10);
  const key = digestContentKey(date);
  if (!force) {
    const cached = await redis.get(key);
    if (cached !== null) {
      return JSON.parse(cached) as DigestContent;
    }
  }

  const sourceLists: Partial<Record<Source, DigestItem[]>> = {};
  for (const source of SOURCES) {
    sourceLists[source] = await mapItems(db, await sourceBoard(db, source, DIGEST_TOP_SOURCE));
  }
  const content: DigestContent = {
    date,
    all: await mapItems(db, await allBoard(db, DIGEST_TOP_ALL)),
    sources: sourceLists,
    mcpNew: await mcpNewItems(db, now),
    papers: await paperItems(db),
  };
  await redis.set(key, JSON.stringify(content), 'EX', DIGEST_TTL_SECONDS);
  return content;
}
