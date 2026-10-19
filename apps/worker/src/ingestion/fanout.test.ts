import { describe, expect, it } from 'vitest';

import { COLD_SPREAD_WINDOW_MS, planSnapshotBatches, snapshotHourSlot } from './fanout.js';

describe('snapshot-fanout planning (spec §7.2)', () => {
  it('splits a tier into ceil(count / batchItems) batches', () => {
    expect(planSnapshotBatches(1_200, 'hot', 500)).toEqual([
      { batch: 0, batchCount: 3, delayMs: 0 },
      { batch: 1, batchCount: 3, delayMs: 0 },
      { batch: 2, batchCount: 3, delayMs: 0 },
    ]);
    expect(planSnapshotBatches(500, 'warm', 500)).toHaveLength(1);
    expect(planSnapshotBatches(501, 'warm', 500)).toHaveLength(2);
    expect(planSnapshotBatches(1, 'hot', 500)).toEqual([{ batch: 0, batchCount: 1, delayMs: 0 }]);
  });

  it('enqueues nothing when the tier is empty', () => {
    expect(planSnapshotBatches(0, 'hot', 500)).toEqual([]);
  });

  it('spreads cold batches evenly across the 01:30–04:00 window', () => {
    const batches = planSnapshotBatches(1_200, 'cold', 500);
    expect(batches.map((entry) => entry.delayMs)).toEqual([
      0,
      Math.round(COLD_SPREAD_WINDOW_MS / 3),
      Math.round((2 * COLD_SPREAD_WINDOW_MS) / 3),
    ]);
    expect(batches.at(-1)?.delayMs).toBeLessThan(COLD_SPREAD_WINDOW_MS);
  });

  it('treats a non-positive batch size as one item per batch', () => {
    expect(planSnapshotBatches(2, 'hot', 0).map((entry) => entry.batch)).toEqual([0, 1]);
  });

  it('derives the deterministic job-id slot from the job timestamp', () => {
    expect(snapshotHourSlot(Date.parse('2026-10-19T12:34:56Z'))).toBe('2026-10-19T12');
  });
});
