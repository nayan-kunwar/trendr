import { sql } from 'drizzle-orm';

import type { Db } from './client.js';

/**
 * Task 1.2 wrappers around the SQL functions defined in
 * `migrations/0001_partitions.sql` and `0006_partition_lead.sql` (spec §6.3).
 * The maintenance job (`maintenance:create-partitions`) calls
 * `ensurePartitions(db, 0, 12)`; retention calls
 * `dropOldPartitions(db, SNAPSHOT_RETENTION_MONTHS)`.
 */

/** M-11: `snapshots_default` already holds rows inside the window to create. */
export class PartitionWindowBlockedError extends Error {
  override readonly name = 'PartitionWindowBlockedError';

  constructor(
    readonly rows: number,
    readonly monthsBack: number,
    readonly monthsAhead: number,
  ) {
    super(
      `snapshots_default holds ${rows} row(s) inside the ${monthsBack}-back/${monthsAhead}-ahead ` +
        'partition window; creating those partitions would violate the partition constraint. ' +
        'Move the rows into their monthly partitions (see docs/runbook.md) and re-run create-partitions.',
    );
  }
}

/**
 * Creates (idempotently) monthly `snapshots` partitions for −monthsBack..+monthsAhead, UTC bounds.
 *
 * M-11: the call pre-flights `snapshots_default`, because a single default row
 * inside the window makes `CREATE TABLE ... PARTITION OF` fail with a raw
 * constraint error after some partitions were already created. The guard turns
 * that into one actionable error before any DDL runs.
 */
export async function ensurePartitions(
  db: Db,
  monthsBack: number,
  monthsAhead: number,
): Promise<void> {
  const blocked = await partitionWindowRows(db, monthsBack, monthsAhead);
  if (blocked > 0) throw new PartitionWindowBlockedError(blocked, monthsBack, monthsAhead);
  await db.execute(sql`SELECT ensure_snapshot_partitions(${monthsBack}, ${monthsAhead})`);
}

/** M-11: default-partition rows that would block the given creation window. */
export async function partitionWindowRows(
  db: Db,
  monthsBack: number,
  monthsAhead: number,
): Promise<number> {
  const result = await db.execute<{ rows: string }>(
    sql`SELECT snapshot_partition_window_rows(${monthsBack}, ${monthsAhead})::text AS rows`,
  );
  return Number(result.rows[0]?.rows ?? 0);
}

/**
 * M-11: days until the newest monthly partition's upper bound. Exported as
 * `trendr_partition_lead_days`; the `PartitionLeadShort` alert fires below the
 * threshold, well before a new insert could fall into `snapshots_default`.
 */
export async function partitionLeadDays(db: Db): Promise<number> {
  const result = await db.execute<{ days: number }>(
    sql`SELECT snapshot_partition_lead_days() AS days`,
  );
  return result.rows[0]?.days ?? 0;
}

/** Drops monthly partitions older than `keepMonths` whole months; returns how many were dropped. */
export async function dropOldPartitions(db: Db, keepMonths: number): Promise<number> {
  const result = await db.execute<{ dropped: number }>(
    sql`SELECT drop_old_snapshot_partitions(${keepMonths}) AS dropped`,
  );
  return result.rows[0]?.dropped ?? 0;
}

/**
 * ISS-7/§14.1: `snapshots_default` must stay empty or partition creation for
 * that date range fails. The maintenance job reports this on every daily run.
 */
export async function countSnapshotsDefault(db: Db): Promise<number> {
  const result = await db.execute<{ count: string }>(sql`
    SELECT count(*)::text AS count FROM snapshots_default`);
  return Number(result.rows[0]?.count ?? 0);
}
