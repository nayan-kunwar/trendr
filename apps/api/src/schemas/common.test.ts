import { describe, expect, it } from 'vitest';

import {
  KeysetCursor,
  LeaderboardCursor,
  buildNextLink,
  decodeCursor,
  encodeCursor,
  nextLinkHeader,
} from './common.js';

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

  it('carries an optional run id for the trending SQL keyset', () => {
    expect(decodeCursor(encodeCursor({ r: '81234', k: 7.5, i: '42' }), KeysetCursor)).toEqual({
      r: '81234',
      k: 7.5,
      i: '42',
    });
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('not-base64-json!', KeysetCursor)).toThrow();
    expect(() => decodeCursor(encodeCursor({ nope: true }), KeysetCursor)).toThrow();
  });
});

/** Spec §10.5: `Link: <...>; rel="next"` on pages with a next cursor. */
describe('next-page Link header (spec §10.5)', () => {
  it('sets the cursor, preserving the other query parameters', () => {
    expect(buildNextLink('/v1/search?q=nxt&limit=2', 'CUR')).toBe(
      '/v1/search?q=nxt&limit=2&cursor=CUR',
    );
    expect(buildNextLink('/v1/new?days=7&cursor=OLD', 'NEW')).toBe('/v1/new?days=7&cursor=NEW');
    expect(buildNextLink('/v1/trending', 'CUR')).toBe('/v1/trending?cursor=CUR');
  });

  it('does not truncate query strings that contain more than one "?"', () => {
    expect(buildNextLink('/v1/search?q=a?b', 'CUR')).toBe('/v1/search?q=a%3Fb&cursor=CUR');
  });

  it('wraps the absolute URL with rel="next"', () => {
    expect(nextLinkHeader('https://api.trendr.dev', '/v1/search?q=a', 'C')).toBe(
      '<https://api.trendr.dev/v1/search?q=a&cursor=C>; rel="next"',
    );
  });
});
