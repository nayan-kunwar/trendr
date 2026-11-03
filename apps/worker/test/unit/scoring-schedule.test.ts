import { describe, expect, it } from 'vitest';

import { SCORING_SLOT_MS, delayToNextScoringSlot } from '../../src/queues.js';

/**
 * L-8: ingest-triggered scoring is delayed to the next ten-minute slot so a
 * snapshot fan-out completes before one board rebuild runs. The delay must be
 * strictly inside one slot and zero exactly on a boundary.
 */

describe('scoring slot delay (L-8)', () => {
  it('waits until the end of the current ten-minute slot', () => {
    expect(SCORING_SLOT_MS).toBe(600_000);
    expect(delayToNextScoringSlot(new Date('2026-11-03T12:00:00Z'))).toBe(0);
    expect(delayToNextScoringSlot(new Date('2026-11-03T12:00:01Z'))).toBe(599_000);
    expect(delayToNextScoringSlot(new Date('2026-11-03T12:09:59Z'))).toBe(1_000);
    expect(delayToNextScoringSlot(new Date('2026-11-03T12:10:30Z'))).toBe(570_000);
  });

  it('never exceeds one slot', () => {
    for (let minutes = 0; minutes < 20; minutes += 1) {
      const at = new Date(`2026-11-03T12:${String(minutes).padStart(2, '0')}:17Z`);
      const delay = delayToNextScoringSlot(at);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(SCORING_SLOT_MS);
    }
  });
});
