import { sql } from 'drizzle-orm';

import type { Db } from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { dataFreshness } from '../metrics.js';

/** Spec §14.1: freshness is polled every 60 s. */
export const FRESHNESS_INTERVAL_MS = 60_000;

export type FreshnessObserver = (source: string, tier: string, seconds: number) => void;

export interface FreshnessPollerOptions {
  db: Db;
  intervalMs?: number;
  logger?: Logger;
  /** Test seams. */
  now?: () => Date;
  observe?: FreshnessObserver;
  immediate?: boolean;
}

export interface RunningFreshnessPoller {
  poll(): Promise<void>;
  stop(): void;
}

interface FreshnessRow {
  [key: string]: unknown;
  source: string;
  tier: string;
  ageSeconds: number | string;
}

/**
 * `trendr_data_freshness_seconds{source,tier}` (spec §14.1): age of the newest
 * snapshot, computed from the denormalized `items.last_snapshot_at` column.
 * Deleted and upstream-archived items are excluded so an old archived item
 * cannot make an otherwise healthy tier look permanently stale.
 */
export async function loadFreshness(
  db: Db,
  now: Date,
): Promise<{ source: string; tier: string; seconds: number }[]> {
  const result = await db.execute<FreshnessRow>(sql`
    SELECT source::text AS source,
           tier::text AS tier,
           EXTRACT(EPOCH FROM (${now}::timestamptz - max(last_snapshot_at)))::double precision
             AS "ageSeconds"
    FROM items
    WHERE last_snapshot_at IS NOT NULL
      AND is_deleted = false
      AND is_archived = false
    GROUP BY source, tier`);
  return result.rows.map((row) => ({
    source: row.source,
    tier: row.tier,
    seconds: Number(row.ageSeconds),
  }));
}

export function startFreshnessPoller(options: FreshnessPollerOptions): RunningFreshnessPoller {
  const now = options.now ?? (() => new Date());
  const observe: FreshnessObserver =
    options.observe ??
    ((source, tier, seconds) => {
      dataFreshness.set({ source, tier }, seconds);
    });
  let stopped = false;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const rows = await loadFreshness(options.db, now());
      // Reset so a source/tier group that disappeared does not leave a stale value.
      dataFreshness.reset();
      for (const row of rows) observe(row.source, row.tier, row.seconds);
    } catch (error) {
      options.logger?.warn({ err: error }, 'data-freshness poll failed');
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, options.intervalMs ?? FRESHNESS_INTERVAL_MS);
  timer.unref();
  if (options.immediate !== false) void poll();

  return {
    poll,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
