import { sql } from 'drizzle-orm';

import type { Db } from './client.js';

/**
 * Task 1.2 wrappers around the SQL functions defined in
 * `migrations/0001_partitions.sql` (spec §6.3). The maintenance job
 * (`maintenance:create-partitions`) calls `ensurePartitions(db, 0, 3)`;
 * retention calls `dropOldPartitions(db, SNAPSHOT_RETENTION_MONTHS)`.
 */

/** Creates (idempotently) monthly `snapshots` partitions for −monthsBack..+monthsAhead, UTC bounds. */
export async function ensurePartitions(
  db: Db,
  monthsBack: number,
  monthsAhead: number,
): Promise<void> {
  await db.execute(sql`SELECT ensure_snapshot_partitions(${monthsBack}, ${monthsAhead})`);
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
