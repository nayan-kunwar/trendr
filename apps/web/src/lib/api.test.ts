import { describe, expect, it } from 'vitest';

import { streamUrl } from '@/lib/api';

describe('streamUrl', () => {
  it('targets the SSE leaderboard route rather than the bare stream prefix', () => {
    const url = new URL(streamUrl('all', '24h'));
    expect(url.pathname).toBe('/v1/stream/leaderboard');
    expect(url.searchParams.get('scope')).toBe('all');
    expect(url.searchParams.get('window')).toBe('24h');
  });
});
