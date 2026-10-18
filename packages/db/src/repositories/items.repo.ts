import { sql } from 'drizzle-orm';

import type { ItemFlag, ItemKind, Metric, Source } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { items } from '../schema/items.js';

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

/**
 * Bulk upsert by the natural key `(source, external_id)` (spec §6.2). On
 * conflict the upstream-owned columns are replaced by the new values while
 * `tier`, `is_deleted`, `first_seen_at`, `last_snapshot_at` and
 * `latest_metrics` are preserved. `flags` merge as a union so system flags
 * (`burst_suspected`, `manual_hidden`) survive adapter writes. Returns the ids
 * so callers can write snapshots in the same transaction.
 */
export async function upsertItems(db: DbExecutor, rows: ItemUpsert[]): Promise<UpsertedItem[]> {
  if (rows.length === 0) return [];

  return db
    .insert(items)
    .values(rows.map((row) => ({ ...row, flags: row.flags ?? [] })))
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
