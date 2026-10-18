import { and, asc, eq, gt, inArray, lt, sql } from 'drizzle-orm';

import type { ItemKind, Metric, Source } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { items, itemTopics, topics } from '../schema/items.js';
import { dailyMetrics } from '../schema/metrics.js';

/**
 * Spec §9.3 — leaderboard card halves: the item metadata of `card:*` payloads
 * and the `current`/`sparkline` series. Shared by the worker (card minting in
 * `publishLeaderboards`, §9.2) and the API (deep pages and missing-card
 * hydration, §9.3) so both sides render identical entries.
 */

const DAY_MS = 86_400_000;
/** Daily sparkline points per card ("up to 30 points", spec §5). */
export const SPARKLINE_POINTS = 30;

export interface CardItem {
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

export interface CardSeries {
  current: number;
  sparkline: number[];
}

/** Items with their topic slugs, one query each (spec §9.3 `WHERE id = ANY($1)`). */
export async function loadCardItems(
  db: DbExecutor,
  ids: readonly bigint[],
): Promise<Map<bigint, CardItem>> {
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
export async function loadCardSeries(
  db: DbExecutor,
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
