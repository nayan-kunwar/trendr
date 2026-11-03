import { randomUUID } from 'node:crypto';

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

interface RenameRow {
  id: bigint;
  externalId: string;
  flags: string[];
  kind: ItemKind;
  primaryMetric: Metric;
  description: string | null;
  url: string;
  homepage: string | null;
  language: string | null;
  license: string | null;
  owner: string | null;
}

interface RenameCandidate {
  index: number;
  input: ItemRenameInput;
  row: RenameRow;
}

/**
 * Spec §5.4 — an upstream rename: move `items.external_id` to the new slug and
 * keep the old name resolvable. The old name gets a `tier='cold'`,
 * `flags=['stub']` item (deliberately *not* soft-deleted so `/aliases` still
 * exposes it) plus an `item_aliases` row (`same_project`, confidence 1) from
 * the renamed item to the stub. The stub keeps the previous metadata and URL
 * but no `upstream_id` — that stays unique to the live row.
 *
 * H-4: several renames from one chunk are applied as one batch. Every moving
 * row is staged through a temporary `external_id` first, so swaps and chains
 * can resolve targets that are themselves moving. When the target name is a
 * cold rename stub, the stub is merged into the live row instead of being
 * treated as a conflict; the live row id — and with it snapshots, scores and
 * watchlists — survives the round trip.
 */
export async function applyItemRenames(
  db: DbExecutor,
  inputs: readonly ItemRenameInput[],
): Promise<ItemRenameOutcome[]> {
  const outcomes: ItemRenameOutcome[] = inputs.map(() => 'item-missing');
  const groups = new Map<Source, { index: number; input: ItemRenameInput }[]>();
  inputs.forEach((input, index) => {
    if (input.fromExternalId === input.toExternalId) {
      outcomes[index] = 'renamed';
      return;
    }
    const group = groups.get(input.source) ?? [];
    group.push({ index, input });
    groups.set(input.source, group);
  });

  for (const [source, entries] of groups) {
    await applySourceRenameBatch(db, source, entries, outcomes);
  }
  return outcomes;
}

/** One rename; kept for callers that do not have a chunk to batch. */
export async function applyItemRename(
  db: DbExecutor,
  input: ItemRenameInput,
): Promise<ItemRenameOutcome> {
  const [outcome] = await applyItemRenames(db, [input]);
  return outcome ?? 'item-missing';
}

async function applySourceRenameBatch(
  db: DbExecutor,
  source: Source,
  entries: readonly { index: number; input: ItemRenameInput }[],
  outcomes: ItemRenameOutcome[],
): Promise<void> {
  const itemIds = [...new Set(entries.map((entry) => entry.input.itemId))];
  const rows = await db
    .select({
      id: items.id,
      externalId: items.externalId,
      flags: items.flags,
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
    .where(and(eq(items.source, source), inArray(items.id, itemIds)))
    .orderBy(asc(items.id))
    .for('update');
  const rowById = new Map(rows.map((row) => [row.id, row]));

  const seen = new Set<bigint>();
  let active: RenameCandidate[] = [];
  for (const entry of entries) {
    const row = rowById.get(entry.input.itemId);
    if (row === undefined) {
      outcomes[entry.index] = 'item-missing';
      continue;
    }
    if (row.externalId !== entry.input.fromExternalId || seen.has(row.id)) {
      outcomes[entry.index] = 'item-missing';
      continue;
    }
    seen.add(row.id);
    active.push({ index: entry.index, input: entry.input, row });
  }
  if (active.length === 0) return;

  const targets = await db
    .select({ id: items.id, externalId: items.externalId, flags: items.flags })
    .from(items)
    .where(
      and(
        eq(items.source, source),
        inArray(items.externalId, [
          ...new Set(active.map((candidate) => candidate.input.toExternalId)),
        ]),
      ),
    )
    .orderBy(asc(items.id))
    .for('update');
  const targetByName = new Map(targets.map((target) => [target.externalId, target]));

  // A target held by a live row that is not moving cannot be taken. Removing a
  // blocked move can block a later one, so settle the staging set first.
  for (;;) {
    const movingIds = new Set(active.map((candidate) => candidate.row.id));
    const claimed = new Set<string>();
    const kept: RenameCandidate[] = [];
    let dropped = false;
    for (const candidate of active) {
      const targetName = candidate.input.toExternalId;
      const target = targetByName.get(targetName);
      const blockedByLiveRow =
        target !== undefined &&
        target.id !== candidate.row.id &&
        !target.flags.includes('stub') &&
        !movingIds.has(target.id);
      if (blockedByLiveRow || claimed.has(targetName)) {
        outcomes[candidate.index] = 'target-exists';
        dropped = true;
        continue;
      }
      claimed.add(targetName);
      kept.push(candidate);
    }
    active = kept;
    if (!dropped) break;
    if (active.length === 0) return;
  }

  // Free every moving name before writing a target: this is what makes swaps
  // (A→B, B→A) and chains (A→B, B→C) resolvable.
  for (const candidate of active) {
    await db
      .update(items)
      .set({ externalId: `__trendr_rename_${randomUUID()}`, updatedAt: sql`now()` })
      .where(eq(items.id, candidate.row.id));
  }

  // Rename-back: the target is the stub created by the previous move. Merge
  // its engagement and derived rows into the live item, then delete it.
  const merged = new Set<bigint>();
  for (const candidate of active) {
    const target = targetByName.get(candidate.input.toExternalId);
    if (
      target === undefined ||
      target.id === candidate.row.id ||
      !target.flags.includes('stub') ||
      merged.has(target.id)
    ) {
      continue;
    }
    await mergeItemStub(db, target.id, candidate.row.id);
    merged.add(target.id);
  }

  for (const candidate of active) {
    await db
      .update(items)
      .set({ externalId: candidate.input.toExternalId, updatedAt: sql`now()` })
      .where(eq(items.id, candidate.row.id));
  }

  const finalNames = new Set(active.map((candidate) => candidate.input.toExternalId));
  for (const candidate of active) {
    outcomes[candidate.index] = 'renamed';
    const from = candidate.input.fromExternalId;
    // The vacated name stays live when another row in this batch is moving
    // into it; only a genuinely free name gets a stub.
    if (finalNames.has(from)) continue;

    const inserted = await db
      .insert(items)
      .values({
        source,
        kind: candidate.row.kind,
        externalId: from,
        upstreamId: null,
        name: from.split('/').pop() ?? from,
        displayName: from,
        description: candidate.row.description,
        url: candidate.row.url,
        homepage: candidate.row.homepage,
        language: candidate.row.language,
        license: candidate.row.license,
        owner: candidate.row.owner,
        primaryMetric: candidate.row.primaryMetric,
        tier: 'cold',
        flags: ['stub'],
      })
      .onConflictDoNothing({ target: [items.source, items.externalId] })
      .returning({ id: items.id });

    let stubId = inserted[0]?.id;
    if (stubId === undefined) {
      const [existing] = await db
        .select({ id: items.id })
        .from(items)
        .where(and(eq(items.source, source), eq(items.externalId, from)));
      if (existing === undefined) {
        throw new Error(`rename stub for "${from}" vanished mid-transaction`);
      }
      stubId = existing.id;
    }
    if (stubId === candidate.row.id) continue;

    await db
      .insert(itemAliases)
      .values({
        itemId: candidate.row.id,
        aliasItemId: stubId,
        relation: 'same_project',
        confidence: 1,
        evidence: candidate.input.evidence,
      })
      .onConflictDoNothing();
  }
}

/**
 * H-4: fold a cold rename stub into the live row before the stub is deleted.
 * Everything user-visible follows the live id; duplicate watchlist rows and
 * alias pairs are dropped so the move cannot violate a primary key.
 */
async function mergeItemStub(db: DbExecutor, stubId: bigint, liveId: bigint): Promise<void> {
  if (stubId === liveId) return;

  await db.execute(sql`
    DELETE FROM watchlist_items AS stub
    USING watchlist_items AS live
    WHERE stub.item_id = ${stubId}
      AND live.item_id = ${liveId}
      AND live.watchlist_id = stub.watchlist_id`);
  await db.execute(sql`
    UPDATE watchlist_items SET item_id = ${liveId} WHERE item_id = ${stubId}`);

  const stubTopics = await db
    .select({ topicId: itemTopics.topicId })
    .from(itemTopics)
    .where(eq(itemTopics.itemId, stubId));
  await db.execute(sql`
    INSERT INTO item_topics (item_id, topic_id)
    SELECT ${liveId}, topic_id FROM item_topics WHERE item_id = ${stubId}
    ON CONFLICT DO NOTHING`);
  await db.delete(itemTopics).where(eq(itemTopics.itemId, stubId));
  if (stubTopics.length > 0) {
    const topicIds = [...new Set(stubTopics.map((row) => row.topicId))].sort((a, b) => a - b);
    await db.execute(sql`
      UPDATE topics t
      SET item_count = (
        SELECT count(*)::int FROM item_topics it WHERE it.topic_id = t.id
      )
      WHERE t.id IN (${sql.join(
        topicIds.map((id) => sql`${id}`),
        sql`, `,
      )})`);
  }

  await db.execute(sql`UPDATE alerts SET item_id = ${liveId} WHERE item_id = ${stubId}`);
  await db.execute(sql`
    UPDATE alert_events SET item_id = ${liveId} WHERE item_id = ${stubId}`);

  await db.execute(sql`
    WITH moved AS (
      SELECT
        CASE WHEN a.item_id = ${stubId} THEN ${liveId} ELSE a.item_id END AS item_id,
        CASE WHEN a.alias_item_id = ${stubId} THEN ${liveId} ELSE a.alias_item_id END AS alias_item_id,
        a.relation,
        a.confidence,
        a.evidence
      FROM item_aliases a
      WHERE a.item_id = ${stubId} OR a.alias_item_id = ${stubId}
    )
    INSERT INTO item_aliases (item_id, alias_item_id, relation, confidence, evidence)
    SELECT item_id, alias_item_id, relation, confidence, evidence
    FROM moved
    WHERE item_id <> alias_item_id
    ON CONFLICT (item_id, alias_item_id, relation) DO NOTHING`);
  await db.execute(sql`
    DELETE FROM item_aliases WHERE item_id = ${stubId} OR alias_item_id = ${stubId}`);

  const deleted = await db
    .delete(items)
    .where(and(eq(items.id, stubId), sql`'stub' = ANY(${items.flags})`))
    .returning({ id: items.id });
  if (deleted.length === 0) {
    throw new Error(`rename stub ${stubId.toString()} disappeared during merge`);
  }
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
  /** Owning source; the admin service invalidates that source's board caches (L-8). */
  source: Source;
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
    source: items.source,
    tier: items.tier,
    flags: items.flags,
    updatedAt: items.updatedAt,
  });
  return row ?? null;
}
