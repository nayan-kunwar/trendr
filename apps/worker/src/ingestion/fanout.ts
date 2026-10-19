import type { Tier } from '@trendr/core';

/** Spec §7.2 `FANOUT_BATCH_ITEMS` fallback (the env var is authoritative in production). */
export const DEFAULT_FANOUT_BATCH_ITEMS = 500;

/** Spec §7.2: cold snapshot batches spread from the 01:30 tick until 04:00 UTC. */
export const COLD_SPREAD_WINDOW_MS = 150 * 60_000;

export interface SnapshotBatch {
  batch: number;
  batchCount: number;
  /** BullMQ delay so cold batches spread across the window (§7.2). */
  delayMs: number;
}

/**
 * Spec §7.2 — `snapshot-fanout` splits a tier into
 * `ceil(count / FANOUT_BATCH_ITEMS)` child `snapshot` jobs. Cold children are
 * delayed evenly across the 01:30–04:00 window; hot/warm run immediately.
 * An empty tier yields no children (the fan-out run still completes).
 */
export function planSnapshotBatches(
  count: number,
  tier: Tier,
  batchItems: number = DEFAULT_FANOUT_BATCH_ITEMS,
): SnapshotBatch[] {
  const size = Math.max(1, Math.trunc(batchItems));
  const batchCount = Math.ceil(Math.max(0, count) / size);
  const batches: SnapshotBatch[] = [];
  for (let batch = 0; batch < batchCount; batch += 1) {
    const delayMs = tier === 'cold' ? Math.round((batch * COLD_SPREAD_WINDOW_MS) / batchCount) : 0;
    batches.push({ batch, batchCount, delayMs });
  }
  return batches;
}

/** `job.timestamp` → the §5.2 snapshot job-id slot `YYYY-MM-DDTHH` (UTC). */
export function snapshotHourSlot(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 13);
}
