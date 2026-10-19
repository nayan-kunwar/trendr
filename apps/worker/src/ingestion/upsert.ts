import type { Tier } from '@trendr/core';
import {
  upsertDailyMetrics,
  upsertItems,
  upsertSnapshots,
  type DailyMetricUpsert,
  type Db,
  type ItemUpsert,
  type SnapshotUpsert,
} from '@trendr/db';
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
}

/**
 * Spec §7.1 step 5 — bulk upsert of one chunk in a single transaction:
 * `items` (metadata) and, per mode, `snapshots` + `daily_metrics`. Returns
 * how many items were upserted. (`item_topics`, alias resolution and stub
 * items land with the first real adapters — see docs/SPEC_REVIEW.md.)
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
    const upserted = await upsertItems(tx, normalized.map(toItemUpsert), {
      ...(options.newItemTier === undefined ? {} : { newItemTier: options.newItemTier }),
    });
    const idByExternalId = new Map(upserted.map((row) => [row.externalId, row.id]));

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
      await upsertDailyMetrics(tx, daily);
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
  );
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
    metadata: item.metadata,
    ...(item.flags === undefined ? {} : { flags: item.flags }),
  };
}
