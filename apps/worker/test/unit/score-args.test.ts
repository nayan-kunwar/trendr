import { describe, expect, it } from 'vitest';

import { scoringSlot } from '../../src/queues.js';
import { parseScoreArgs } from '../../src/scoring/score-args.js';

/**
 * Task 2.6 (spec §18): the `worker:score` CLI parses exactly what the spec's
 * example passes (`--source github`) and refuses anything else; scoring job
 * ids use ten-minute UTC slots (§5.2).
 */

describe('parseScoreArgs', () => {
  it('defaults to every window for the requested source', () => {
    expect(parseScoreArgs(['--source', 'github'])).toEqual({
      source: 'github',
      windows: ['24h', '7d', '30d'],
    });
  });

  it('accepts, trims and dedupes a window subset', () => {
    expect(parseScoreArgs(['--source', 'npm', '--windows', '30d, 24h,30d'])).toEqual({
      source: 'npm',
      windows: ['30d', '24h'],
    });
  });

  it('rejects a missing or unknown source', () => {
    expect(() => parseScoreArgs([])).toThrow(/--source is required/);
    expect(() => parseScoreArgs(['--source', 'gitlab'])).toThrow(/unknown source/);
  });

  it('rejects unknown or empty window selections', () => {
    expect(() => parseScoreArgs(['--source', 'github', '--windows', '48h'])).toThrow(
      /unknown window/,
    );
    expect(() => parseScoreArgs(['--source', 'github', '--windows', ' , '])).toThrow(
      /at least one window/,
    );
  });
});

describe('scoringSlot', () => {
  it('floors the instant to the ten-minute UTC slot', () => {
    expect(scoringSlot(new Date('2026-10-18T12:00:00Z'))).toBe('2026-10-18T12-00');
    expect(scoringSlot(new Date('2026-10-18T12:09:59Z'))).toBe('2026-10-18T12-00');
    expect(scoringSlot(new Date('2026-10-18T12:10:00Z'))).toBe('2026-10-18T12-10');
    expect(scoringSlot(new Date('2026-10-18T23:59:00Z'))).toBe('2026-10-18T23-50');
  });
});
