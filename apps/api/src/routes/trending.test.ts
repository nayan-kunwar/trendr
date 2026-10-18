import { describe, expect, it } from 'vitest';

import { TrendingQuery } from '../schemas/trending.js';
import { canonicalQuery, hasSqlFilters, trendingEtag } from './trending.js';

const base = TrendingQuery.parse({});

/** Spec §9.4 (ETag shape) and §9.3 (which requests leave the ZSET path). */
describe('trending route helpers (spec §9.3, §9.4)', () => {
  it('hash the canonical query, including the cursor', () => {
    const page1 = TrendingQuery.parse({ scope: 'github', cursor: 'abc' });
    const page2 = TrendingQuery.parse({ scope: 'github', cursor: 'abd' });
    expect(canonicalQuery(page1)).not.toBe(canonicalQuery(page2));
    // Property order in the incoming object must not matter.
    expect(canonicalQuery(TrendingQuery.parse({ cursor: 'abc', scope: 'github' }))).toBe(
      canonicalQuery(page1),
    );
  });

  it('builds W/"lb-{scope}-{window}-{version}-{sha1(query).slice(0,8)}" and tracks the version', () => {
    const etag = trendingEtag('all', '24h', '7', base);
    expect(etag).toMatch(/^W\/"lb-all-24h-7-[0-9a-f]{8}"$/);
    expect(trendingEtag('all', '24h', '8', base)).not.toBe(etag);
    expect(trendingEtag('github', '24h', '7', base)).not.toBe(etag);
  });

  it('routes topic/kind/minCurrent and newOnly=true to the SQL path', () => {
    expect(hasSqlFilters(base)).toBe(false);
    expect(hasSqlFilters(TrendingQuery.parse({ newOnly: 'false' }))).toBe(false);
    expect(hasSqlFilters(TrendingQuery.parse({ newOnly: 'true' }))).toBe(true);
    expect(hasSqlFilters(TrendingQuery.parse({ topic: 'ai-agents' }))).toBe(true);
    expect(hasSqlFilters(TrendingQuery.parse({ kind: 'repo' }))).toBe(true);
    expect(hasSqlFilters(TrendingQuery.parse({ minCurrent: '10' }))).toBe(true);
  });
});
