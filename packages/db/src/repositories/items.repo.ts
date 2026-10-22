import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';

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
  /**
   * Additive extension of the §5.1 shape: upstream deletion. A true value
   * sets `is_deleted`; a false/absent value never resurrects a soft-deleted
   * row (deletion is monotonic until an explicit admin restore).
   */
  isDeleted?: boolean;
  metadata: Record<string, unknown>;
  flags?: ItemFlag[];
  /**
   * Additive extension of the §5.1 shape: rolling/gauge values that belong in
   * `latest_metrics` but must not create a snapshot series (HF `downloads`).
   */
  latestMetrics?: Partial<Record<Metric, number>>;
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
  /**
   * Keep the existing descriptive columns and identity (name, display_name,
   * url) when the incoming payload is metadata-less. Daily jobs (§7.1 step 4:
   * "only the daily series") carry no metadata for npm/PyPI, and MCP derived
   * snapshots carry only alias metrics (§7.3.6); without this either refresh
   * would blank stored metadata.
   */
  preserveMetadata?: boolean;
  /**
   * Keep `primary_metric` from the existing row. Metrics-only payloads (MCP
   * derived snapshots) must not downgrade a GitHub-linked item to downloads
   * merely because the alias target has no snapshot yet.
   */
  preservePrimaryMetric?: boolean;
}

/**
 * Bulk upsert by the natural key `(source, external_id)` (spec §6.2). On
 * conflict the upstream-owned columns are replaced by the new values while
 * `tier`, `is_deleted`, `first_seen_at`, `last_snapshot_at` and
 * `latest_metrics` are preserved. `flags` merge as a union so system flags
 * (`burst_suspected`, `manual_hidden`) survive adapter writes. With
 * `preserveMetadata`, a null descriptive column keeps the stored value
 * (daily jobs carry only the download series). Returns the ids so callers can
 * write snapshots in the same transaction.
 */
export async function upsertItems(
  db: DbExecutor,
  rows: ItemUpsert[],
  options: UpsertItemsOptions = {},
): Promise<UpsertedItem[]> {
  if (rows.length === 0) return [];
  const description = options.preserveMetadata
    ? sql`coalesce(excluded.description, ${items.description})`
    : sql`excluded.description`;
  const homepage = options.preserveMetadata
    ? sql`coalesce(excluded.homepage, ${items.homepage})`
    : sql`excluded.homepage`;
  const language = options.preserveMetadata
    ? sql`coalesce(excluded.language, ${items.language})`
    : sql`excluded.language`;
  const license = options.preserveMetadata
    ? sql`coalesce(excluded.license, ${items.license})`
    : sql`excluded.license`;
  const owner = options.preserveMetadata
    ? sql`coalesce(excluded.owner, ${items.owner})`
    : sql`excluded.owner`;
  const name = options.preserveMetadata ? sql`${items.name}` : sql`excluded.name`;
  const displayName = options.preserveMetadata
    ? sql`${items.displayName}`
    : sql`excluded.display_name`;
  const url = options.preserveMetadata ? sql`${items.url}` : sql`excluded.url`;
  const primaryMetric = options.preservePrimaryMetric
    ? sql`${items.primaryMetric}`
    : sql`excluded.primary_metric`;

  return db
    .insert(items)
    .values(
      rows.map((row) => ({
        ...row,
        flags: row.flags ?? [],
        latestMetrics: row.latestMetrics ?? {},
        isDeleted: row.isDeleted ?? false,
        ...(options.newItemTier === undefined ? {} : { tier: options.newItemTier }),
      })),
    )
    .onConflictDoUpdate({
      target: [items.source, items.externalId],
      set: {
        upstreamId: sql`coalesce(excluded.upstream_id, ${items.upstreamId})`,
        name,
        displayName,
        description,
        url,
        homepage,
        language,
        license,
        owner,
        primaryMetric,
        upstreamCreatedAt: sql`coalesce(excluded.upstream_created_at, ${items.upstreamCreatedAt})`,
        isArchived: sql`excluded.is_archived`,
        // §7.3.6: an upstream delete is sticky; a later active payload does
        // not silently resurrect the row (an admin restore is explicit).
        isDeleted: sql`${items.isDeleted} OR excluded.is_deleted`,
        metadata: sql`${items.metadata} || excluded.metadata`,
        latestMetrics: sql`${items.latestMetrics} || excluded.latest_metrics`,
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

/** Spec §7.8 — watchlist adds promote an item to the hot tier immediately. */
export async function markItemHot(db: DbExecutor, id: bigint, now: Date): Promise<void> {
  await db.update(items).set({ tier: 'hot', updatedAt: now }).where(eq(items.id, id));
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

/** Rename-detection row: what `upstream_id` currently points at (spec §5.4). */
export interface ItemByUpstreamId {
  id: bigint;
  externalId: string;
}

/**
 * Spec §5.4 — the tracked rows for a batch of upstream node ids. Used before
 * the `(source, external_id)` upsert to spot renames: same node id, new name.
 */
export async function loadItemsByUpstreamIds(
  db: DbExecutor,
  source: Source,
  upstreamIds: readonly string[],
): Promise<Map<string, ItemByUpstreamId>> {
  if (upstreamIds.length === 0) return new Map();
  const rows = await db
    .select({ id: items.id, externalId: items.externalId, upstreamId: items.upstreamId })
    .from(items)
    .where(and(eq(items.source, source), inArray(items.upstreamId, [...upstreamIds])));
  const byUpstreamId = new Map<string, ItemByUpstreamId>();
  for (const row of rows) {
    if (row.upstreamId !== null) {
      byUpstreamId.set(row.upstreamId, { id: row.id, externalId: row.externalId });
    }
  }
  return byUpstreamId;
}

export interface ItemRenameInput {
  source: Source;
  /** The tracked row whose `external_id` changed upstream. */
  itemId: bigint;
  fromExternalId: string;
  toExternalId: string;
  /** `item_aliases.evidence`, e.g. `github_rename` (spec §5.4). */
  evidence: string;
}

export type ItemRenameOutcome = 'renamed' | 'target-exists' | 'item-missing';

/**
 * Spec §5.4 — an upstream rename: move `items.external_id` to the new slug and
 * keep the old name resolvable. The old name gets a `tier='cold'`,
 * `flags=['stub']` item (deliberately *not* soft-deleted so `/aliases` still
 * exposes it) plus an `item_aliases` row (`same_project`, confidence 1) from
 * the renamed item to the stub. The stub keeps the previous metadata and URL
 * but no `upstream_id` — that stays unique to the live row.
 */
export async function applyItemRename(
  db: DbExecutor,
  input: ItemRenameInput,
): Promise<ItemRenameOutcome> {
  if (input.fromExternalId === input.toExternalId) return 'renamed';

  const [current] = await db
    .select({
      id: items.id,
      kind: items.kind,
      primaryMetric: items.primaryMetric,
      description: items.description,
      url: items.url,
      homepage: items.homepage,
      language: items.language,
      license: items.license,
      owner: items.owner,
    })
    .from(items)
    .where(and(eq(items.source, input.source), eq(items.externalId, input.fromExternalId)));
  if (current?.id !== input.itemId) return 'item-missing';

  const [target] = await db
    .select({ id: items.id })
    .from(items)
    .where(and(eq(items.source, input.source), eq(items.externalId, input.toExternalId)));
  if (target !== undefined && target.id !== input.itemId) return 'target-exists';

  await db
    .update(items)
    .set({ externalId: input.toExternalId, updatedAt: sql`now()` })
    .where(eq(items.id, input.itemId));

  const inserted = await db
    .insert(items)
    .values({
      source: input.source,
      kind: current.kind,
      externalId: input.fromExternalId,
      upstreamId: null,
      name: input.fromExternalId.split('/').pop() ?? input.fromExternalId,
      displayName: input.fromExternalId,
      description: current.description,
      url: current.url,
      homepage: current.homepage,
      language: current.language,
      license: current.license,
      owner: current.owner,
      primaryMetric: current.primaryMetric,
      tier: 'cold',
      flags: ['stub'],
    })
    .onConflictDoNothing({ target: [items.source, items.externalId] })
    .returning({ id: items.id });

  let stubId = inserted[0]?.id;
  if (stubId === undefined) {
    // The old name is already tracked (e.g. rename back and forth): reuse it.
    const [existing] = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.source, input.source), eq(items.externalId, input.fromExternalId)));
    if (existing === undefined) {
      throw new Error(`rename stub for "${input.fromExternalId}" vanished mid-transaction`);
    }
    stubId = existing.id;
  }

  await db
    .insert(itemAliases)
    .values({
      itemId: input.itemId,
      aliasItemId: stubId,
      relation: 'same_project',
      confidence: 1,
      evidence: input.evidence,
    })
    .onConflictDoNothing();

  return 'renamed';
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
  /** Spec §7.8: archived items get a weekly existence check only, never a daily fetch. */
  excludeArchived?: boolean;
}

/**
 * Spec §7.1 step 4 — the tracked (non-deleted) items of one source,
 * `ORDER BY id`, optionally restricted to one tier and to the fan-out slice
 * `id % batchCount = batch`. Alias stubs (§5.4) are excluded: they are name
 * shadows kept for lookups, and fetching the old slug would hit a 301 that
 * redirects are never allowed to follow.
 */
export async function listTrackedItems(
  db: DbExecutor,
  query: TrackedItemsQuery,
): Promise<TrackedItemRef[]> {
  return db
    .select({ id: items.id, externalId: items.externalId, kind: items.kind, tier: items.tier })
    .from(items)
    .where(and(...trackedItemFilters(query)))
    .orderBy(asc(items.id));
}

/**
 * Spec §7.2 — the tier size a `snapshot-fanout` job splits. Uses the same
 * filters as `listTrackedItems` (deleted + alias stubs excluded), so the child
 * batches cover exactly the rows a snapshot would fetch.
 */
export async function countTrackedItems(db: DbExecutor, query: TrackedItemsQuery): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(items)
    .where(and(...trackedItemFilters(query)));
  return row?.count ?? 0;
}

function trackedItemFilters(query: TrackedItemsQuery) {
  const filters = [
    eq(items.source, query.source),
    eq(items.isDeleted, false),
    // Alias stubs (§5.4) are name shadows, not upstream-tracked rows: fetching
    // the old slug would hit a 301 that redirects are never allowed to follow.
    sql`NOT ('stub' = ANY(${items.flags}))`,
  ];
  if (query.tier !== undefined) {
    filters.push(eq(items.tier, query.tier));
  }
  if (query.excludeArchived === true) {
    filters.push(sql`${items.tier} <> 'archived'`);
  }
  if (query.batch !== undefined && query.batchCount !== undefined) {
    filters.push(sql`${items.id} % ${query.batchCount} = ${query.batch}`);
  }
  return filters;
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

/** One item's last stored metric values — the 304 continuity source (§7.3.1). */
export interface LatestItemMetrics {
  id: bigint;
  latestMetrics: Partial<Record<string, number>>;
}

/** Spec §7.3.1 — `latest_metrics` for the items about to be continuity-written. */
export async function loadLatestMetricsByIds(
  db: DbExecutor,
  itemIds: readonly bigint[],
): Promise<LatestItemMetrics[]> {
  if (itemIds.length === 0) return [];
  return db
    .select({ id: items.id, latestMetrics: items.latestMetrics })
    .from(items)
    .where(inArray(items.id, [...itemIds]));
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

/** Spec §10.1 `PATCH /v1/admin/items/:id` body. */
export interface AdminItemPatch {
  tier?: Tier;
  addFlags?: ItemFlag[];
  removeFlags?: ItemFlag[];
}

export interface AdminItemPatchResult {
  id: bigint;
  tier: Tier;
  flags: string[];
  updatedAt: Date;
}

/**
 * Spec §10.1 — operator item patch: set the tier and/or merge flags
 * (`addFlags` union, then `removeFlags`), returning the new state. A missing
 * item returns null so the route can answer 404. System flags can be edited
 * deliberately (e.g. clearing `manual_hidden`).
 */
export async function patchItemAdmin(
  db: DbExecutor,
  itemId: bigint,
  patch: AdminItemPatch,
): Promise<AdminItemPatchResult | null> {
  const set: { updatedAt: SQL; tier?: Tier; flags?: SQL } = { updatedAt: sql`now()` };
  if (patch.tier !== undefined) {
    set.tier = patch.tier;
  }
  if (patch.addFlags !== undefined || patch.removeFlags !== undefined) {
    // `sql.param` keeps each flag list a single `text[]` binding: a bare
    // interpolation would spread the array into one placeholder per element.
    const added = patch.addFlags ?? [];
    const removed = patch.removeFlags ?? [];
    set.flags = sql`(
      SELECT COALESCE(array_agg(DISTINCT f ORDER BY f), '{}'::text[])
      FROM unnest(${items.flags} || ${sql.param(added)}::text[]) AS t(f)
      WHERE NOT (f = ANY(${sql.param(removed)}::text[]))
    )`;
  }

  const [row] = await db.update(items).set(set).where(eq(items.id, itemId)).returning({
    id: items.id,
    tier: items.tier,
    flags: items.flags,
    updatedAt: items.updatedAt,
  });
  return row ?? null;
}
