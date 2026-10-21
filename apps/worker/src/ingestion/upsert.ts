import { and, eq, inArray, sql } from 'drizzle-orm';

import { normalizeTopicSlugs, type Metric, type Source, type Tier } from '@trendr/core';
import {
  applyItemRename,
  itemAliases,
  itemTopics,
  items,
  loadItemsByUpstreamIds,
  topics,
  upsertDailyMetrics,
  upsertItems,
  upsertSnapshots,
  type DailyMetricUpsert,
  type Db,
  type DbExecutor,
  type ItemUpsert,
  type SnapshotUpsert,
} from '@trendr/db';
import type { Logger } from '@trendr/logger';
import type { NormalizedItem } from '@trendr/sources';

/** Spec §6.3 — snapshot bucket start: hourly for hot/warm, daily for cold. */
export function bucketCapturedAt(tier: Tier, now: Date): Date {
  const bucket = new Date(now);
  bucket.setUTCMinutes(0, 0, 0);
  if (tier === 'cold' || tier === 'archived') {
    bucket.setUTCHours(0);
  }
  return bucket;
}

/**
 * `snapshot` writes items + snapshots + daily metrics; `daily` refreshes only
 * the per-day series (spec §7.1 step 4, "as snapshot, but only the daily
 * series").
 */
export type PersistMode = 'snapshot' | 'daily';

export interface PersistOptions {
  mode: PersistMode;
  capturedAt: Date;
  runId: bigint | null;
  /** Snapshot bucket tier; required when `mode` is `snapshot`. */
  tier?: Tier;
  /** Tier for newly inserted items (discover starts items `warm`); existing tiers are preserved. */
  newItemTier?: Tier;
  /**
   * Keep stored descriptive columns/identity when the payload is derived
   * (MCP alias metrics, §7.3.6) rather than freshly discovered upstream.
   */
  preserveMetadata?: boolean;
  /** Receives rename detections (§5.4); omit in tests. */
  logger?: Logger;
}

/**
 * Spec §7.1 step 5 — bulk upsert of one chunk in a single transaction:
 * `items` (metadata), `item_topics`, upstream rename handling (§5.4), per-mode
 * `snapshots` + `daily_metrics`, and alias resolution. Returns how many items
 * were upserted.
 */
export async function persistNormalizedItems(
  db: Db,
  normalized: NormalizedItem[],
  options: PersistOptions,
): Promise<number> {
  if (normalized.length === 0) return 0;
  const capturedAt =
    options.tier === undefined
      ? options.capturedAt
      : bucketCapturedAt(options.tier, options.capturedAt);

  return db.transaction(async (tx) => {
    // §5.4: detect renames via the stable `upstream_id` first, so the
    // (source, external_id) upsert below lands on the renamed row instead of
    // inserting a duplicate under the new name.
    await applySourceRenames(tx, normalized, options.logger);
    const upserted = await upsertItems(tx, normalized.map(toItemUpsert), {
      ...(options.newItemTier === undefined ? {} : { newItemTier: options.newItemTier }),
      // Daily jobs carry only the download series (npm/PyPI) and MCP snapshots
      // carry only alias metrics: keep the metadata written by discovery.
      preserveMetadata: options.mode === 'daily' || options.preserveMetadata === true,
      preservePrimaryMetric: options.mode === 'daily' || options.preserveMetadata === true,
    });
    const idByExternalId = new Map(upserted.map((row) => [row.externalId, row.id]));
    await persistTopics(tx, normalized, idByExternalId);
    await persistAliases(tx, normalized, idByExternalId);

    const snapshots: SnapshotUpsert[] = [];
    const daily: DailyMetricUpsert[] = [];
    for (const item of normalized) {
      const itemId = idByExternalId.get(item.item.externalId);
      if (itemId === undefined) {
        continue; // upsert returns every row; defensive only
      }
      if (options.mode === 'snapshot') {
        for (const point of item.snapshots) {
          snapshots.push({
            itemId,
            metric: point.metric,
            capturedAt,
            observedAt: options.capturedAt,
            value: point.value,
            runId: options.runId,
          });
        }
      }
      for (const point of item.daily) {
        daily.push({ itemId, metric: point.metric, day: point.day, value: point.value });
      }
    }

    if (snapshots.length > 0) {
      await upsertSnapshots(tx, snapshots, { refreshAggregates: true });
    }
    if (daily.length > 0) {
      await upsertDailyMetrics(tx, daily, { refreshAggregates: true });
    }
    return upserted.length;
  });
}

/** One backfill result (spec §5.1 `adapter.backfill`) → `daily_metrics`. */
export async function persistDailySeries(
  db: Db,
  itemId: bigint,
  rows: NormalizedItem['daily'],
): Promise<void> {
  if (rows.length === 0) return;
  await upsertDailyMetrics(
    db,
    rows.map((row) => ({ itemId, metric: row.metric, day: row.day, value: row.value })),
    { refreshAggregates: true },
  );
}

/**
 * Spec §5.4 — detect upstream renames inside one chunk: group the payloads by
 * `(source, upstream_id)`, load the tracked rows for those node ids and let
 * `applyItemRename` move any row whose `external_id` changed. Identification
 * is by node id, never by name.
 */
async function applySourceRenames(
  db: DbExecutor,
  normalized: readonly NormalizedItem[],
  logger?: Logger,
): Promise<void> {
  const bySource = new Map<Source, Map<string, string>>();
  for (const { item } of normalized) {
    if (item.upstreamId === null) continue;
    const externalIdByUpstreamId = bySource.get(item.source) ?? new Map<string, string>();
    externalIdByUpstreamId.set(item.upstreamId, item.externalId);
    bySource.set(item.source, externalIdByUpstreamId);
  }

  for (const [source, externalIdByUpstreamId] of bySource) {
    const existing = await loadItemsByUpstreamIds(db, source, [...externalIdByUpstreamId.keys()]);
    for (const [upstreamId, externalId] of externalIdByUpstreamId) {
      const row = existing.get(upstreamId);
      if (row === undefined || row.externalId === externalId) continue;
      const outcome = await applyItemRename(db, {
        source,
        itemId: row.id,
        fromExternalId: row.externalId,
        toExternalId: externalId,
        evidence: `${source}_rename`, // §5.4 e.g. `github_rename`
      });
      if (outcome === 'renamed') {
        logger?.info(
          { source, from: row.externalId, to: externalId },
          'tracked item renamed upstream',
        );
      } else if (outcome === 'target-exists') {
        logger?.warn(
          { source, from: row.externalId, to: externalId },
          'rename target already tracked; keeping both rows',
        );
      }
    }
  }
}

export interface ContinuitySnapshotInput {
  itemId: bigint;
  metrics: Partial<Record<Metric, number>>;
}

/**
 * Spec §7.3.1 — `304 Not Modified` continuity: rewrite an item's last stored
 * values into the current bucket so the series (and the next scoring window)
 * stays continuous without touching upstream. Returns snapshot rows written.
 */
export async function persistContinuitySnapshots(
  db: DbExecutor,
  rows: readonly ContinuitySnapshotInput[],
  options: { tier: Tier; capturedAt: Date; runId: bigint | null },
): Promise<number> {
  const capturedAt = bucketCapturedAt(options.tier, options.capturedAt);
  const snapshots: SnapshotUpsert[] = [];
  for (const row of rows) {
    for (const [metric, value] of Object.entries(row.metrics)) {
      if (typeof value !== 'number') continue;
      snapshots.push({
        itemId: row.itemId,
        metric: metric as Metric,
        capturedAt,
        observedAt: options.capturedAt,
        value,
        runId: options.runId,
      });
    }
  }
  if (snapshots.length === 0) return 0;
  await upsertSnapshots(db, snapshots, { refreshAggregates: true });
  return snapshots.length;
}

/**
 * Spec §7.1 step 5 — persist the adapter-normalized topic slugs and refresh
 * `topics.item_count` for the touched topics. Links are additive: an adapter
 * that later omits a topic does not erase a previously observed one.
 */
async function persistTopics(
  db: DbExecutor,
  normalized: readonly NormalizedItem[],
  idByExternalId: ReadonlyMap<string, bigint>,
): Promise<void> {
  const slugsByItem = new Map<bigint, string[]>();
  const touched = new Set<string>();
  for (const item of normalized) {
    const itemId = idByExternalId.get(item.item.externalId);
    if (itemId === undefined) continue;
    const slugs = normalizeTopicSlugs(item.item.topics);
    if (slugs.length === 0) continue;
    slugsByItem.set(itemId, slugs);
    for (const slug of slugs) touched.add(slug);
  }
  if (touched.size === 0) return;

  const slugs = [...touched];
  await db
    .insert(topics)
    .values(slugs.map((slug) => ({ slug, name: topicName(slug) })))
    .onConflictDoNothing();
  const topicRows = await db
    .select({ id: topics.id, slug: topics.slug })
    .from(topics)
    .where(inArray(topics.slug, slugs));
  const topicIdBySlug = new Map(topicRows.map((row) => [row.slug, row.id]));

  const links: { itemId: bigint; topicId: number }[] = [];
  for (const [itemId, itemSlugs] of slugsByItem) {
    for (const slug of itemSlugs) {
      const topicId = topicIdBySlug.get(slug);
      if (topicId !== undefined) links.push({ itemId, topicId });
    }
  }
  if (links.length === 0) return;

  await db.insert(itemTopics).values(links).onConflictDoNothing();
  // Sort IDs so concurrent chunks lock topic rows in the same order and cannot
  // deadlock while refreshing the denormalized counts.
  const topicIds = [...new Set(links.map((link) => link.topicId))].sort((a, b) => a - b);
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

function topicName(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part === '' ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

/**
 * Spec §7.1 step 5/§7.3.6 — persist `item_aliases` and create a minimal target
 * row for every unseen alias. Targets start `warm` (not the rename `stub`
 * flag) so their own source adapter snapshots them; that is how an MCP item
 * inherits GitHub stars or npm/PyPI downloads.
 */
async function persistAliases(
  db: DbExecutor,
  normalized: readonly NormalizedItem[],
  idByExternalId: ReadonlyMap<string, bigint>,
): Promise<void> {
  const targets = new Map<string, NormalizedItem['aliases'][number]>();
  for (const item of normalized) {
    for (const alias of item.aliases) {
      if (alias.source === item.item.source && alias.externalId === item.item.externalId) continue;
      targets.set(aliasKey(alias.source, alias.externalId), alias);
    }
  }
  if (targets.size === 0) return;

  const bySource = new Map<Source, string[]>();
  for (const alias of targets.values()) {
    const externalIds = bySource.get(alias.source) ?? [];
    externalIds.push(alias.externalId);
    bySource.set(alias.source, externalIds);
  }

  const resolved = new Map<string, { id: bigint; isDeleted: boolean }>();
  for (const [source, externalIds] of bySource) {
    const rows = await db
      .select({ id: items.id, externalId: items.externalId, isDeleted: items.isDeleted })
      .from(items)
      .where(and(eq(items.source, source), inArray(items.externalId, externalIds)));
    for (const row of rows) {
      resolved.set(aliasKey(source, row.externalId), { id: row.id, isDeleted: row.isDeleted });
    }
  }

  const missing = [...targets.entries()].filter(([key]) => !resolved.has(key));
  if (missing.length > 0) {
    const inserted = await db
      .insert(items)
      .values(missing.map(([, alias]) => aliasTargetRow(alias)))
      .onConflictDoNothing({ target: [items.source, items.externalId] })
      .returning({
        id: items.id,
        source: items.source,
        externalId: items.externalId,
        isDeleted: items.isDeleted,
      });
    for (const row of inserted) {
      resolved.set(aliasKey(row.source, row.externalId), {
        id: row.id,
        isDeleted: row.isDeleted,
      });
    }
  }

  // Spec §7.3.6: alias targets are promoted to tier ≥ warm so their source
  // adapter snapshots them. New rows above already start warm; existing cold
  // or archived rows need the explicit promotion.
  const promoteIds = [...resolved.values()]
    .filter((target) => !target.isDeleted)
    .map((target) => target.id);
  if (promoteIds.length > 0) {
    await db
      .update(items)
      .set({ tier: 'warm' })
      .where(and(inArray(items.id, promoteIds), inArray(items.tier, ['cold', 'archived'])));
  }

  const rows: {
    itemId: bigint;
    aliasItemId: bigint;
    relation: NormalizedItem['aliases'][number]['relation'];
    confidence: number;
    evidence: string;
  }[] = [];
  for (const item of normalized) {
    const itemId = idByExternalId.get(item.item.externalId);
    if (itemId === undefined) continue;
    for (const alias of item.aliases) {
      const target = resolved.get(aliasKey(alias.source, alias.externalId));
      if (target === undefined || target.isDeleted || target.id === itemId) continue;
      rows.push({
        itemId,
        aliasItemId: target.id,
        relation: alias.relation,
        confidence: alias.confidence,
        evidence: alias.evidence,
      });
    }
  }
  if (rows.length === 0) return;
  await db
    .insert(itemAliases)
    .values(rows)
    .onConflictDoNothing({
      target: [itemAliases.itemId, itemAliases.aliasItemId, itemAliases.relation],
    });
}

function aliasKey(source: Source, externalId: string): string {
  return `${source}:${externalId}`;
}

function aliasTargetRow(alias: NormalizedItem['aliases'][number]) {
  return {
    source: alias.source,
    kind: alias.kind,
    externalId: alias.externalId,
    upstreamId: null,
    name: aliasName(alias.externalId),
    displayName: alias.externalId,
    description: null,
    url: aliasTargetUrl(alias.source, alias.externalId),
    homepage: null,
    language: null,
    license: null,
    owner: null,
    primaryMetric: aliasTargetMetric(alias.source),
    upstreamCreatedAt: null,
    isArchived: false,
    metadata: { aliasStub: true },
    tier: 'warm' as const,
  };
}

function aliasName(externalId: string): string {
  const slash = externalId.lastIndexOf('/');
  return slash === -1 ? externalId : externalId.slice(slash + 1);
}

function aliasTargetUrl(source: Source, externalId: string): string {
  switch (source) {
    case 'github':
      return `https://github.com/${externalId}`;
    case 'npm':
      return `https://www.npmjs.com/package/${externalId}`;
    case 'pypi':
      return `https://pypi.org/project/${encodeURIComponent(externalId)}/`;
    case 'huggingface': {
      const repoId = externalId.replace(/^models\//, '');
      return `https://huggingface.co/${repoId}`;
    }
    case 'arxiv':
      return `https://arxiv.org/abs/${externalId}`;
    case 'mcp':
      return `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(externalId)}/versions/latest`;
  }
}

function aliasTargetMetric(source: Source): Metric {
  switch (source) {
    case 'github':
      return 'stars';
    case 'npm':
    case 'pypi':
      return 'downloads';
    case 'huggingface':
      return 'likes';
    case 'arxiv':
      return 'upvotes';
    case 'mcp':
      return 'stars';
  }
}

function toItemUpsert(normalized: NormalizedItem): ItemUpsert {
  const item = normalized.item;
  return {
    source: item.source,
    kind: item.kind,
    externalId: item.externalId,
    upstreamId: item.upstreamId,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    url: item.url,
    homepage: item.homepage,
    language: item.language,
    license: item.license,
    owner: item.owner,
    primaryMetric: item.primaryMetric,
    upstreamCreatedAt: item.upstreamCreatedAt,
    isArchived: item.isArchived,
    ...(normalized.deleted === true ? { isDeleted: true } : {}),
    metadata: item.metadata,
    ...(item.flags === undefined ? {} : { flags: item.flags }),
    ...(normalized.latestMetrics === undefined ? {} : { latestMetrics: normalized.latestMetrics }),
  };
}
