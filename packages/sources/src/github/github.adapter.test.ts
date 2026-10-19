import { readFileSync } from 'node:fs';

import { createLogger } from '@trendr/logger';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterContext, DiscoveredRef } from '../adapter.js';
import { createGitHubAdapter, type BucketLike, type GitHubEtagStore } from './github.adapter.js';

/**
 * Spec §18 task 4.3 — request-shape tests: GraphQL batch size (≤ 50 aliases),
 * `If-None-Match` conditional refresh (304), `Accept:
 * application/vnd.github.star+json` on the backfill walk, date slicing of
 * `created:` ranges and the §7.4 reserve pause behaviour.
 */

const NOW = new Date('2026-10-19T12:00:00Z');
const GITHUB = 'https://api.github.com';

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

interface FakeBucket {
  takes: number[];
  pauses: number[];
  take: BucketLike['take'];
  pauseUntil: BucketLike['pauseUntil'];
}

function fakeBucket(): FakeBucket {
  const bucket: FakeBucket = {
    takes: [],
    pauses: [],
    take(cost) {
      bucket.takes.push(cost ?? 1);
      return Promise.resolve();
    },
    pauseUntil(until) {
      bucket.pauses.push(until);
      return Promise.resolve();
    },
  };
  return bucket;
}

interface Harness {
  adapter: ReturnType<typeof createGitHubAdapter>;
  core: FakeBucket[];
  search: FakeBucket;
  graphql: FakeBucket;
  etags: GitHubEtagStore & { stored: Map<string, string> };
}

function harness(
  options: {
    tokenCount?: number;
    etags?: Map<string, string>;
    reserve?: number;
    backfillMaxPages?: number;
  } = {},
): Harness {
  const tokenCount = options.tokenCount ?? 2;
  const core = Array.from({ length: tokenCount }, () => fakeBucket());
  const search = fakeBucket();
  const graphql = fakeBucket();
  const stored = options.etags ?? new Map<string, string>();
  const etags: Harness['etags'] = {
    stored,
    get: (itemId) => Promise.resolve(stored.get(itemId.toString()) ?? null),
    set: (itemId, etag) => {
      stored.set(itemId.toString(), etag);
      return Promise.resolve();
    },
  };
  const adapter = createGitHubAdapter({
    tokens: Array.from({ length: tokenCount }, (_, index) => `token-${index}`),
    userAgent: 'Trendr-Test/1.0',
    ...(options.reserve === undefined ? {} : { reserve: options.reserve }),
    ...(options.backfillMaxPages === undefined
      ? {}
      : { backfillMaxPages: options.backfillMaxPages }),
    buckets: { core, search, graphql },
    etags,
  });
  return { adapter, core, search, graphql, etags };
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    logger: createLogger({ service: 'worker', level: 'error' }),
    bucket: fakeBucket() as unknown as AdapterContext['bucket'],
    signal: new AbortController().signal,
    now: () => NOW,
    runId: 7n,
    ...overrides,
  };
}

function ref(externalId: string, itemId?: bigint): DiscoveredRef {
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    ...(itemId === undefined ? {} : { itemId }),
  };
}

type RequestHeaders = Headers | Record<string, string | string[]> | undefined;

function header(headers: RequestHeaders, name: string): string | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return undefined;
}

function gqlRepo(slug: string): Record<string, unknown> {
  const [owner] = slug.split('/');
  return {
    id: `R_${slug.replace('/', '_')}`,
    nameWithOwner: slug,
    url: `https://github.com/${slug}`,
    description: null,
    homepageUrl: null,
    createdAt: '2026-01-01T00:00:00Z',
    pushedAt: null,
    isArchived: false,
    isFork: false,
    stargazerCount: 10,
    forkCount: 1,
    watchers: { totalCount: 2 },
    issues: { totalCount: 3 },
    primaryLanguage: null,
    repositoryTopics: { nodes: [] },
    licenseInfo: null,
    owner: { login: owner ?? 'acme' },
  };
}

const searchBase = (() => {
  const parsed = readJson('search-new-hot.json') as { items?: Record<string, unknown>[] };
  const item = parsed.items?.[0];
  if (item === undefined) throw new Error('search fixture missing items[0]');
  return item;
})();

let searchItemSeq = 0;

function searchItem(slug: string, stars = 30): Record<string, unknown> {
  const [owner, name] = slug.split('/');
  searchItemSeq += 1;
  return {
    ...searchBase,
    id: 900_000_000 + searchItemSeq,
    node_id: `R_${slug.replace('/', '_')}`,
    name: name ?? slug,
    full_name: slug,
    owner: { login: owner ?? 'acme' },
    html_url: `https://github.com/${slug}`,
    url: `https://api.github.com/repos/${slug}`,
    description: null,
    homepage: null,
    language: null,
    license: null,
    fork: false,
    archived: false,
    created_at: '2026-10-13T09:00:00Z',
    pushed_at: '2026-10-18T09:00:00Z',
    stargazers_count: stars,
    forks_count: 4,
    open_issues_count: 1,
    topics: [],
  };
}

const originalDispatcher: Dispatcher = getGlobalDispatcher();
let agent: MockAgent;
let pool: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  pool = agent.get(GITHUB);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
  vi.restoreAllMocks();
});

describe('github adapter request shapes (spec §7.3.1)', () => {
  it('batches at most 50 aliases per GraphQL call and rotates tokens', async () => {
    const seen: { aliases: number; auth: string | undefined; typed: boolean }[] = [];
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply((opts) => {
        if (typeof opts.body !== 'string') throw new TypeError('expected a string body');
        const body = JSON.parse(opts.body) as {
          query: string;
          variables: Record<string, string>;
        };
        const count = Object.keys(body.variables).filter((key) => key.startsWith('o')).length;
        const data: Record<string, unknown> = {
          rateLimit: { cost: 1, remaining: 4987, resetAt: '2026-10-19T13:00:00Z' },
        };
        for (let index = 0; index < count; index += 1) {
          data[`r${index}`] = gqlRepo(`acme/repo-${String(index)}`);
        }
        seen.push({
          aliases: (body.query.match(/r\d+:/g) ?? []).length,
          auth: header(opts.headers, 'authorization'),
          typed: body.query.includes('rateLimit { cost remaining resetAt }'),
        });
        return {
          statusCode: 200,
          data: JSON.stringify({ data }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(2);

    const onRateLimit = vi.fn();
    const ctx = context({ onRateLimit });
    const refs = Array.from({ length: 52 }, (_, index) => ref(`acme/repo-${String(index)}`));
    const fetched = await harness({ tokenCount: 2 }).adapter.fetchMetrics(ctx, refs, {
      tier: 'hot',
    });

    expect(fetched).toHaveLength(52);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.aliases).toBe(50);
    expect(seen[1]?.aliases).toBe(2);
    expect(seen[0]?.auth).toBe('Bearer token-0');
    expect(seen[1]?.auth).toBe('Bearer token-1');
    expect(seen.every((entry) => entry.typed)).toBe(true);
    expect(onRateLimit).toHaveBeenCalledWith({
      resource: 'graphql',
      remaining: 4987,
      resetAt: new Date('2026-10-19T13:00:00Z'),
    });
  });

  it('sends If-None-Match for tracked items and stores fresh ETags', async () => {
    const h = harness({ tokenCount: 1, etags: new Map([['7', 'W/"etag-old"']]) });
    let sent: string | undefined;
    pool.intercept({ path: '/repos/acme/vector-forge', method: 'GET' }).reply((opts) => {
      sent = header(opts.headers, 'if-none-match');
      return {
        statusCode: 200,
        data: JSON.stringify(readJson('rest-repo.json')),
        responseOptions: {
          headers: { 'content-type': 'application/json', etag: 'W/"etag-new"' },
        },
      };
    });

    const [item] = await h.adapter.fetchMetrics(context(), [ref('acme/vector-forge', 7n)], {
      tier: 'hot',
    });

    expect(sent).toBe('W/"etag-old"');
    expect(h.etags.stored.get('7')).toBe('W/"etag-new"');
    expect(item?.raw).not.toBeNull();
    expect(h.core[0]?.takes).toEqual([1]);
  });

  it('maps a 304 to notModified and keeps the stored ETag', async () => {
    const h = harness({ tokenCount: 1, etags: new Map([['7', 'W/"etag-old"']]) });
    pool.intercept({ path: '/repos/acme/vector-forge', method: 'GET' }).reply(304, '');

    const [item] = await h.adapter.fetchMetrics(context(), [ref('acme/vector-forge', 7n)], {
      tier: 'hot',
    });

    expect(item?.notModified).toBe(true);
    expect(item?.raw).toBeNull();
    expect(h.etags.stored.get('7')).toBe('W/"etag-old"');
    if (item === undefined) throw new Error('missing fetched item');
    expect(h.adapter.normalize(item)).toBeNull();
  });

  it('maps a 404 to notFound without throwing', async () => {
    const h = harness({ tokenCount: 1 });
    pool
      .intercept({ path: '/repos/acme/gone', method: 'GET' })
      .reply(404, JSON.stringify({ message: 'Not Found' }));

    const [item] = await h.adapter.fetchMetrics(context(), [ref('acme/gone', 9n)], {
      tier: 'hot',
    });

    expect(item?.notFound).toBe(true);
  });

  it('reports rate-limit state, pauses below GITHUB_RESERVE and reports PAT expiry (GAP-8)', async () => {
    const h = harness({ tokenCount: 1 });
    // The adapter compares the reset against the real clock, so anchor it to now.
    const resetEpoch = Math.floor(Date.now() / 1000) + 1_800;
    const onRateLimit = vi.fn();
    const onTokenExpiry = vi.fn();

    pool
      .intercept({ path: '/repos/acme/vector-forge', method: 'GET' })
      .reply(200, JSON.stringify(readJson('rest-repo.json')), {
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '120',
          'x-ratelimit-reset': String(resetEpoch),
          'x-ratelimit-resource': 'core',
          'github-authentication-token-expiration': '2027-01-15 12:00:00 UTC',
        },
      });
    pool
      .intercept({ path: '/repos/acme/vector-forge', method: 'GET' })
      .reply(200, JSON.stringify(readJson('rest-repo.json')), {
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '4000',
          'x-ratelimit-reset': String(resetEpoch),
          'x-ratelimit-resource': 'core',
        },
      });

    const ctx = context({ onRateLimit, onTokenExpiry });
    await h.adapter.fetchMetrics(ctx, [ref('acme/vector-forge', 1n)], { tier: 'hot' });
    await h.adapter.fetchMetrics(ctx, [ref('acme/vector-forge', 1n)], { tier: 'hot' });

    expect(onRateLimit).toHaveBeenCalledWith({
      resource: 'core',
      remaining: 120,
      resetAt: new Date(resetEpoch * 1000),
    });
    // below the default reserve of 200 → the bucket stays closed until reset
    expect(h.core[0]?.pauses).toEqual([resetEpoch * 1000]);
    expect(onTokenExpiry).toHaveBeenCalledWith({
      tokenIndex: 0,
      expiresAt: new Date('2027-01-15T12:00:00Z'),
    });
  });

  it('slices created: ranges recursively when a search tops 1,000 results', async () => {
    const h = harness({ tokenCount: 1 });
    const queries: string[] = [];
    pool
      .intercept({
        path: (path: string) => path.startsWith('/search/repositories?'),
        method: 'GET',
      })
      .reply((opts) => {
        const url = new URL(`${GITHUB}${opts.path}`);
        const q = url.searchParams.get('q') ?? '';
        queries.push(q);
        const total = q.includes('2026-10-12..2026-10-19') ? 1200 : 5;
        const page = url.searchParams.get('page') ?? '1';
        return {
          statusCode: 200,
          data: JSON.stringify({
            total_count: total,
            incomplete_results: false,
            items: [searchItem(`acme/hot-${page}`)],
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .persist();

    const collected: DiscoveredRef[] = [];
    for await (const page of h.adapter.discover(context(), {
      maxItems: 500,
      strategy: 'new-hot',
    })) {
      collected.push(...page);
    }

    // parent pages 1..10, then both halves of the created: range
    expect(queries).toHaveLength(12);
    expect(queries[0]).toBe('created:2026-10-12..2026-10-19 stars:>=20');
    expect(queries[10]).toBe('created:2026-10-12..2026-10-15 stars:>=20');
    expect(queries[11]).toBe('created:2026-10-16..2026-10-19 stars:>=20');
    expect(collected).toHaveLength(12);
    expect(collected[0]?.hint?.reason).toBe('new-hot');
    expect(collected[0]?.raw).toBeDefined();
    expect(h.search.takes).toHaveLength(12);
  });

  it('stops at maxItems without fetching further pages', async () => {
    const h = harness({ tokenCount: 1 });
    let requests = 0;
    pool
      .intercept({
        path: (path: string) => path.startsWith('/search/repositories?'),
        method: 'GET',
      })
      .reply(() => {
        requests += 1;
        return {
          statusCode: 200,
          data: JSON.stringify({
            total_count: 300,
            incomplete_results: false,
            items: [searchItem('acme/a'), searchItem('acme/b')],
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .persist();

    const collected: DiscoveredRef[] = [];
    for await (const page of h.adapter.discover(context(), {
      maxItems: 1,
      strategy: 'rising',
    })) {
      collected.push(...page);
    }

    expect(collected).toHaveLength(1);
    expect(requests).toBe(1);
  });

  it('runs one search per topic for the topics strategy', async () => {
    const h = harness({ tokenCount: 1 });
    const queries: string[] = [];
    pool
      .intercept({
        path: (path: string) => path.startsWith('/search/repositories?'),
        method: 'GET',
      })
      .reply((opts) => {
        const url = new URL(`${GITHUB}${opts.path}`);
        const q = url.searchParams.get('q') ?? '';
        queries.push(q);
        return {
          statusCode: 200,
          data: JSON.stringify({
            total_count: 1,
            incomplete_results: false,
            items: [searchItem(`acme/topic-${String(queries.length)}`)],
          }),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .persist();

    const collected: DiscoveredRef[] = [];
    for await (const page of h.adapter.discover(context(), {
      maxItems: 1,
      strategy: 'topics',
    })) {
      collected.push(...page);
    }

    expect(collected).toHaveLength(1);
    expect(queries).toEqual(['topic:mcp-server pushed:>2026-10-05 stars:>=10']);
  });

  it('walks stargazers backward with the star+json accept header (spec §7.3.1)', async () => {
    const h = harness({ tokenCount: 1 });
    const accepts: (string | undefined)[] = [];
    const pages: string[] = [];
    const record = (opts: { path: string; headers?: RequestHeaders }) => {
      pages.push(opts.path);
      accepts.push(header(opts.headers, 'accept'));
    };

    pool
      .intercept({ path: '/repos/acme/vector-forge/stargazers?per_page=100&page=1', method: 'GET' })
      .reply((opts) => {
        record(opts);
        return {
          statusCode: 200,
          data: JSON.stringify(readJson('stargazers-page-1.json')),
          responseOptions: {
            headers: {
              'content-type': 'application/json',
              link: `<${GITHUB}/repos/acme/vector-forge/stargazers?per_page=100&page=3>; rel="last"`,
            },
          },
        };
      });
    pool
      .intercept({ path: '/repos/acme/vector-forge/stargazers?per_page=100&page=3', method: 'GET' })
      .reply((opts) => {
        record(opts);
        return {
          statusCode: 200,
          data: JSON.stringify(readJson('stargazers-last.json')),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });
    pool
      .intercept({ path: '/repos/acme/vector-forge/stargazers?per_page=100&page=2', method: 'GET' })
      .reply((opts) => {
        record(opts);
        return {
          statusCode: 200,
          data: JSON.stringify([
            { starred_at: '2026-09-14T11:00:00Z', user: { login: 'old' } },
            { starred_at: '2026-09-20T08:00:00Z', user: { login: 'mid' } },
          ]),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });

    const daily = await h.adapter.backfill?.(context(), ref('acme/vector-forge'), 35);

    // probe page 1 → last, walk 3 then 2 (page 2 crosses the 35-day cutoff, so it stops)
    expect(pages).toEqual([
      '/repos/acme/vector-forge/stargazers?per_page=100&page=1',
      '/repos/acme/vector-forge/stargazers?per_page=100&page=3',
      '/repos/acme/vector-forge/stargazers?per_page=100&page=2',
    ]);
    expect(accepts).toEqual([
      'application/vnd.github.star+json',
      'application/vnd.github.star+json',
      'application/vnd.github.star+json',
    ]);
    expect(daily).toHaveLength(35);
    expect(daily?.[0]).toEqual({ metric: 'stars', day: '2026-09-14', value: 199 });
    expect(daily?.at(-1)).toEqual({ metric: 'stars', day: '2026-10-18', value: 202 });
  });

  it('caps the stargazer walk at BACKFILL_GITHUB_MAX_PAGES and omits uncovered days (GAP-7)', async () => {
    const h = harness({ tokenCount: 1, backfillMaxPages: 2 });
    const pages: string[] = [];
    pool
      .intercept({ path: '/repos/acme/big/stargazers?per_page=100&page=1', method: 'GET' })
      .reply((opts) => {
        pages.push(opts.path);
        return {
          statusCode: 200,
          data: JSON.stringify([]),
          responseOptions: {
            headers: {
              'content-type': 'application/json',
              link: `<${GITHUB}/repos/acme/big/stargazers?per_page=100&page=5>; rel="last"`,
            },
          },
        };
      });
    pool
      .intercept({ path: '/repos/acme/big/stargazers?per_page=100&page=5', method: 'GET' })
      .reply((opts) => {
        pages.push(opts.path);
        return {
          statusCode: 200,
          data: JSON.stringify([{ starred_at: '2026-10-17T10:00:00Z', user: { login: 'recent' } }]),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      });

    const daily = await h.adapter.backfill?.(context(), ref('acme/big'), 35);

    expect(pages).toHaveLength(2); // probe + one walk page, then the cap stops the walk
    // only days whose post-boundary stars are fully covered are emitted
    expect(daily).toEqual([
      { metric: 'stars', day: '2026-10-17', value: 401 },
      { metric: 'stars', day: '2026-10-18', value: 401 },
    ]);
  });

  it('marks per-alias NOT_FOUND results and keeps the rest of the batch', async () => {
    const h = harness({ tokenCount: 1 });
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(200, JSON.stringify(readJson('graphql-batch.json')), {
        headers: { 'content-type': 'application/json' },
      });

    const fetched = await h.adapter.fetchMetrics(
      context(),
      [ref('acme/vector-forge'), ref('legacy-labs/gone-away'), ref('legacy-labs/old-forge')],
      { tier: 'hot' },
    );

    expect(fetched.map((item) => item.notFound === true)).toEqual([false, true, false]);
    expect(fetched[0]?.raw).not.toBeNull();
    expect(fetched[2]?.raw).not.toBeNull();
  });

  it('fails the batch on fatal GraphQL errors, keeping rate limits retryable', async () => {
    const h = harness({ tokenCount: 1 });
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(
        200,
        JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Bad credentials' }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );
    pool
      .intercept({ path: '/graphql', method: 'POST' })
      .reply(
        200,
        JSON.stringify({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'rate limited' }] }),
        {
          headers: { 'content-type': 'application/json' },
        },
      );

    await expect(
      h.adapter.fetchMetrics(context(), [ref('acme/a'), ref('acme/b')], { tier: 'hot' }),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      h.adapter.fetchMetrics(context(), [ref('acme/a'), ref('acme/b')], { tier: 'hot' }),
    ).rejects.toMatchObject({ retryable: true });
  });
});
