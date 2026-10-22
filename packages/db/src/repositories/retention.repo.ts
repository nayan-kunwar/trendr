import { sql } from 'drizzle-orm';

import type { DbExecutor } from '../client.js';

/** §6.5/§7.10: rows per delete statement. */
export const RETENTION_BATCH_SIZE = 1_000;

export interface RetentionPruneResult {
  alertEvents: number;
  ingestionRuns: number;
}

/** Delete `alert_events` older than the cutoff in bounded batches. */
export async function pruneAlertEvents(
  db: DbExecutor,
  before: Date,
  batchSize = RETENTION_BATCH_SIZE,
): Promise<number> {
  return deleteInBatches(
    db,
    sql`
      WITH doomed AS (
        SELECT id FROM alert_events
        WHERE triggered_at < ${before}
        ORDER BY triggered_at
        LIMIT ${batchSize}
      )
      DELETE FROM alert_events a USING doomed d WHERE a.id = d.id
      RETURNING a.id`,
  );
}

/**
 * Delete old `ingestion_runs` that no retained object still references.
 * Scores, the current-run pointer, and alert events all hold restrictive FKs;
 * the NOT EXISTS guards make the delete FK-safe even if a scoring run is kept
 * past the 30-day run horizon by the scores policy.
 */
export async function pruneIngestionRuns(
  db: DbExecutor,
  before: Date,
  batchSize = RETENTION_BATCH_SIZE,
): Promise<number> {
  return deleteInBatches(
    db,
    sql`
      WITH doomed AS (
        SELECT r.id
        FROM ingestion_runs r
        WHERE r.started_at < ${before}
          AND NOT EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM score_runs_current c WHERE c.run_id = r.id)
          AND NOT EXISTS (SELECT 1 FROM alert_events e WHERE e.score_run_id = r.id)
        ORDER BY r.started_at
        LIMIT ${batchSize}
      )
      DELETE FROM ingestion_runs r USING doomed d WHERE r.id = d.id
      RETURNING r.id`,
  );
}

async function deleteInBatches(db: DbExecutor, statement: ReturnType<typeof sql>): Promise<number> {
  let deleted = 0;
  for (;;) {
    const result = await db.execute<{ id: string }>(statement);
    const count = result.rowCount ?? result.rows.length;
    deleted += count;
    if (count === 0) return deleted;
  }
}
