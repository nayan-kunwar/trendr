import { describe, expect, it } from 'vitest';

import { StreamQuery } from './stream.js';

describe('StreamQuery (spec §10.6)', () => {
  it('defaults to the combined board over 24h', () => {
    expect(StreamQuery.parse({})).toEqual({ scope: 'all', window: '24h' });
  });

  it('accepts source scopes and known windows', () => {
    expect(StreamQuery.parse({ scope: 'github', window: '7d' })).toEqual({
      scope: 'github',
      window: '7d',
    });
  });

  it('rejects unknown scopes and windows', () => {
    expect(StreamQuery.safeParse({ scope: 'bitbucket' }).success).toBe(false);
    expect(StreamQuery.safeParse({ window: '1h' }).success).toBe(false);
  });
});
