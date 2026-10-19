import { and, asc, eq, sql } from 'drizzle-orm';

import type { ItemFlag, ItemKind, Metric, Source, Tier, Window } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { aliasRelEnum } from '../schema/enums.js';
import { itemAliases, itemTopics, items, topics } from '../schema/items.js';
import { scoreRunsCurrent, scores } from '../schema/metrics.js';

/**
 * Upsert input for one item — exactly `NormalizedItem['item']` (spec §5.1):
 * adapter-owned metadata only. `tier`, `latest_metrics`, `last_snapshot_at`,
 * `first_seen_at` and the deletion state are never touched by this upsert;
 * they are owned by tiering, the snapshot flow and explicit admin actions.
 */
export interface ItemUpsert {
  source: Source;
  kind: ItemKind;
  externalId: string;
  upstreamId: string | null;
  name: string;
  displayName: string;
  description: string | null;
  url: string;
  homepage: string | null;
  language: string | null;
  license: string | null;
  owner: string | null;
  primaryMetric: Metric;
  upstreamCreatedAt: Date | null;
  isArchived: boolean;
  metadata: Record<string, unknown>;
  flags?: ItemFlag[];
}

export interface UpsertedItem {
  id: bigint;
  source: Source;
  externalId: string;
}

export interface UpsertItemsOptions {
  /**
   * Tier written only for rows that are *inserted* by this call (spec §7.1:
   * discovered items start `warm`). Conflicts preserve the existing tier —
   * tiering owns it after the first write.
   */
  newItemTier?: Tier;
}

/**
 * Bulk upsert by the natural key `(source, external_id)` (spec §6.2). On
 * conflict the upstream-owned columns are replaced by the new values while
 * `tier`, `is_deleted`, `first_seen_at`, `last_snapshot_at` and
 * `latest_metrics` are preserved. `flags` merge as a union so system flags
 * (`burst_suspected`, `manual_hidden`) survive adapter writes. Returns the ids
 * so callers can write snapshots in the same transaction.
 */
export async function upsertItems(
  db: DbExecutor,
  rows: ItemUpsert[],
  options: UpsertItemsOptions = {},
): Promise<UpsertedItem[]> {
  if (rows.length === 0) return [];

  return db
    .insert(items)
    .values(
      rows.map((row) => ({
        ...row,
        flags: row.flags ?? [],
        ...(options.newItemTier === undefined ? {} : { tier: options.newItemTier }),
      })),
    )
    .onConflictDoUpdate({
      target: [items.source, items.externalId],
      set: {
        upstreamId: sql`coalesce(excluded.upstream_id, ${items.upstreamId})`,
        name: sql`excluded.name`,
        displayName: sql`excluded.display_name`,
        description: sql`excluded.description`,
        url: sql`excluded.url`,
        homepage: sql`excluded.homepage`,
        language: sql`excluded.language`,
        license: sql`excluded.license`,
        owner: sql`excluded.owner`,
        primaryMetric: sql`excluded.primary_metric`,
        upstreamCreatedAt: sql`coalesce(excluded.upstream_created_at, ${items.upstreamCreatedAt})`,
        isArchived: sql`excluded.is_archived`,
        metadata: sql`${items.metadata} || excluded.metadata`,
        flags: sql`(select coalesce(array_agg(distinct f), '{}'::text[]) from unnest(${items.flags} || excluded.flags) as t(f))`,
        lastSeenAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: items.id, source: items.source, externalId: items.externalId });
}

export type ItemRow = typeof items.$inferSelect;

/** Spec §10.1 `/v1/items/:id`: soft-deleted items are 404s. */
export async function getItemById(db: DbExecutor, id: bigint): Promise<ItemRow | null> {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.id, id), eq(items.isDeleted, false)));
  return row ?? null;
}

/** Spec §10.1 `/v1/items/lookup`: resolve `(source, externalId)` to a live item. */
export async function findItemByNaturalKey(
  db: DbExecutor,
  source: Source,
  externalId: string,
): Promise<{ id: bigint } | null> {
  const [row] = await db
    .select({ id: items.id })
    .from(items)
    .where(
      and(eq(items.source, source), eq(items.externalId, externalId), eq(items.isDeleted, false)),
    );
  return row ?? null;
}

/** The minimum an adapter needs to fetch one tracked item (§7.1 step 4). */
export interface TrackedItemRef {
  id: bigint;
  externalId: string;
  kind: ItemKind;
  tier: Tier;
}

export interface TrackedItemsQuery {
  source: Source;
  tier?: Tier;
  /** `id % batchCount = batch` — the deterministic fan-out slice (spec §7.1). */
  batch?: number;
  batchCount?: number;
}

/**
 * Spec §7.1 step 4 — the tracked (non-deleted) items of one source,
 * `ORDER BY id`, optionally restricted to one tier and to the fan-out slice
 * `id % batchCount = batch`.
 */
export async function listTrackedItems(
  db: DbExecutor,
  query: TrackedItemsQuery,
): Promise<TrackedItemRef[]> {
  const filters = [eq(items.source, query.source), eq(items.isDeleted, false)];
  if (query.tier !== undefined) {
    filters.push(eq(items.tier, query.tier));
  }
  if (query.batch !== undefined && query.batchCount !== undefined) {
    filters.push(sql`${items.id} % ${query.batchCount} = ${query.batch}`);
  }
  return db
    .select({ id: items.id, externalId: items.externalId, kind: items.kind, tier: items.tier })
    .from(items)
    .where(and(...filters))
    .orderBy(asc(items.id));
}

/** Normalized topic slugs of one item (spec §10.4 `topics`), stable order. */
export async function loadItemTopics(db: DbExecutor, itemId: bigint): Promise<string[]> {
  const rows = await db
    .select({ slug: topics.slug })
    .from(itemTopics)
    .innerJoin(topics, eq(topics.id, itemTopics.topicId))
    .where(eq(itemTopics.itemId, itemId))
    .orderBy(asc(topics.slug));
  return rows.map((row) => row.slug);
}

export interface ItemScoreRow {
  window: Window;
  rankSource: number | null;
  rankAll: number | null;
  delta: number;
  relGrowth: number;
  finalScore: number;
  zScore: number;
  percentile: number;
  flags: string[];
}

/** Current-run scores for one item, one row per window that scored it (spec §10.4 `scores`). */
export async function loadItemCurrentScores(
  db: DbExecutor,
  itemId: bigint,
): Promise<ItemScoreRow[]> {
  return db
    .select({
      window: scores.window,
      rankSource: scores.rankSource,
      rankAll: scores.rankAll,
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
    .where(eq(scores.itemId, itemId));
}

export type AliasRelation = (typeof aliasRelEnum.enumValues)[number];

export interface ItemAliasLink {
  /** The linked item on the other side of the relation. */
  id: bigint;
  source: Source;
  kind: ItemKind;
  externalId: string;
  displayName: string;
  url: string;
  relation: AliasRelation;
  confidence: number;
  evidence: string;
  /** `outgoing`: this item's row; `incoming`: the other item's row points here. */
  direction: 'outgoing' | 'incoming';
}

/**
 * Spec §10.1 `/v1/items/:id/aliases`: every `item_aliases` row touching the
 * item, in both directions, with live (non-deleted) link targets. `relation`
 * is always read from the row's own `item_id` perspective.
 */
export async function loadItemAliasLinks(db: DbExecutor, itemId: bigint): Promise<ItemAliasLink[]> {
  const outgoing = await db
    .select({
      id: items.id,
      source: items.source,
      kind: items.kind,
      externalId: items.externalId,
      displayName: items.displayName,
      url: items.url,
      relation: itemAliases.relation,
      confidence: itemAliases.confidence,
      evidence: itemAliases.evidence,
    })
    .from(itemAliases)
    .innerJoin(items, eq(items.id, itemAliases.aliasItemId))
    .where(and(eq(itemAliases.itemId, itemId), eq(items.isDeleted, false)))
    .orderBy(asc(itemAliases.aliasItemId));

  const incoming = await db
    .select({
      id: items.id,
      source: items.source,
      kind: items.kind,
      externalId: items.externalId,
      displayName: items.displayName,
      url: items.url,
      relation: itemAliases.relation,
      confidence: itemAliases.confidence,
      evidence: itemAliases.evidence,
    })
    .from(itemAliases)
    .innerJoin(items, eq(items.id, itemAliases.itemId))
    .where(and(eq(itemAliases.aliasItemId, itemId), eq(items.isDeleted, false)))
    .orderBy(asc(itemAliases.itemId));

  return [
    ...outgoing.map((row) => ({ ...row, direction: 'outgoing' as const })),
    ...incoming.map((row) => ({ ...row, direction: 'incoming' as const })),
  ];
}
