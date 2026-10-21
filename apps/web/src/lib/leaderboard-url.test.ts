import { describe, expect, it } from 'vitest';

import { buildLeaderboardHref } from '@/lib/leaderboard-url';

const base = { scope: 'all', window: '24h', newOnly: false } as const;

describe('buildLeaderboardHref', () => {
  it('changes the window without dropping other filters', () => {
    expect(
      buildLeaderboardHref({ ...base, lang: 'typescript', newOnly: true }, { window: '7d' }),
    ).toBe('/trending/all/7d?lang=typescript&new=true');
  });

  it('keeps URL state canonical when a filter is cleared', () => {
    expect(
      buildLeaderboardHref(
        { ...base, scope: 'github', lang: 'rust', topic: 'cli' },
        { lang: null },
      ),
    ).toBe('/trending/github/24h?topic=cli');
  });

  it('switches source while preserving the window and filters', () => {
    expect(buildLeaderboardHref({ ...base, window: '30d', kind: 'repo' }, { scope: 'mcp' })).toBe(
      '/trending/mcp/30d?kind=repo',
    );
  });
});
