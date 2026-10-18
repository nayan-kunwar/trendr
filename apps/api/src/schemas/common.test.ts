import { describe, expect, it } from 'vitest';

import { KeysetCursor, LeaderboardCursor, decodeCursor, encodeCursor } from './common.js';

/** Spec §10.2 / §16 unit row: cursor encode/decode. */
describe('cursor codecs (spec §10.2)', () => {
  it('round-trips the leaderboard cursor', () => {
    const raw = encodeCursor({ r: '81234', s: 5.409, i: '1033' });
    expect(decodeCursor(raw, LeaderboardCursor)).toEqual({ r: '81234', s: 5.409, i: '1033' });
  });

  it('round-trips the keyset cursor with a numeric or string key', () => {
    expect(decodeCursor(encodeCursor({ k: 7.5, i: '42' }), KeysetCursor)).toEqual({
      k: 7.5,
      i: '42',
    });
    expect(decodeCursor(encodeCursor({ k: '7.5', i: '42' }), KeysetCursor)).toEqual({
      k: '7.5',
      i: '42',
    });
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-base64-json!', KeysetCursor)).toThrow();
    expect(() => decodeCursor(encodeCursor({ nope: true }), KeysetCursor)).toThrow();
  });
});
