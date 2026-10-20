import { readFileSync } from 'node:fs';

import { createLogger } from '@trendr/logger';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdapterContext, DiscoveredRef } from '../adapter.js';
import { createPypiAdapter, type PypiBucketLike, type PypiEtagStore } from './pypi.adapter.js';
import { PypiProjectSchema, PypiStatsOverallSchema } from './schemas.js';
import { overallStatsUrl } from './urls.js';

/**
 * Spec §18 task 5.2 — PyPI request shapes: RSS discovery with the keyword
 * filter and admission rule, seed handling, ETag project refresh, pypistats
 * `overall?mirrors=false` daily windows and the 60-day backfill.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const PYPI = 'https://pypi.org';
const PYPISTATS = 'https://pypistats.org';

const EMPTY_FEED =
  '<?xml version="1.0"?><rss version="2.0"><channel><title>empty</title></channel></rss>';

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const PROJECT = PypiProjectSchema.parse(readJson('project.json'));
const OVERALL = PypiStatsOverallSchema.parse(readJson('stats-overall.json'));
const RECENT = readJson('stats-recent.json');

interface FakeBucket extends PypiBucketLike {
  takes: number[];
  pauses: number[];
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

interface FakeEtagStore extends PypiEtagStore {
  values: Map<string, string>;
  gets: string[];
  sets: { project: string; etag: string }[];
}

function fakeEtagStore(): FakeEtagStore {
  const store: FakeEtagStore = {
    values: new Map(),
    gets: [],
    sets: [],
    get(project) {
      store.gets.push(project);
      return Promise.resolve(store.values.get(project) ?? null);
    },
    set(project, etag) {
      store.sets.push({ project, etag });
      store.values.set(project, etag);
      return Promise.resolve();
    },
  };
  return store;
}

function context(bucket: FakeBucket, overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    logger: createLogger({ service: 'worker', level: 'error' }),
    bucket: bucket as unknown as AdapterContext['bucket'],
    signal: new AbortController().signal,
    now: () => NOW,
    runId: 7n,
    ...overrides,
  };
}

function ref(externalId: string): DiscoveredRef {
  return { source: 'pypi', kind: 'package', externalId };
}

function header(
  headers: Headers | Record<string, string | string[]> | undefined,
  name: string,
): string | undefined {
  if (headers === undefined) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

function feedItem(name: string, description = ''): string {
  return `<item><title>${name} added to PyPI</title><link>https://pypi.org/project/${name}/</link><description>${description}</description></item>`;
}

function feed(...items: string[]): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>feed</title>${items.join('')}</channel></rss>`;
}

const originalDispatcher: Dispatcher = getGlobalDispatcher();
let agent: MockAgent;
let pypiPool: ReturnType<MockAgent['get']>;
let statsPool: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  pypiPool = agent.get(PYPI);
  statsPool = agent.get(PYPISTATS);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
});

function harness(overrides: Partial<Parameters<typeof createPypiAdapter>[0]> = {}): {
  adapter: ReturnType<typeof createPypiAdapter>;
  registryBucket: FakeBucket;
  statsBucket: FakeBucket;
  etags: FakeEtagStore;
} {
  const registryBucket = fakeBucket();
  const statsBucket = fakeBucket();
  const etags = fakeEtagStore();
  const adapter = createPypiAdapter({
    userAgent: 'Trendr-Test/1.0',
    minWeeklyDownloads: 500,
    statsBucket,
    etags,
    seeds: [],
    ...overrides,
  });
  return { adapter, registryBucket, statsBucket, etags };
}

describe('PyPI discovery (spec §7.3.3)', () => {
  it('uses the seeded projects and fetches project JSON plus recent stats', async () => {
    const { adapter, registryBucket, statsBucket } = harness({ seeds: ['mcp'] });
    pypiPool
      .intercept({ path: '/rss/packages.xml' })
      .reply(200, EMPTY_FEED, { headers: { 'content-type': 'application/rss+xml' } })
      .times(1);
    pypiPool
      .intercept({ path: '/rss/updates.xml' })
      .reply(200, EMPTY_FEED, { headers: { 'content-type': 'application/rss+xml' } })
      .times(1);
    pypiPool
      .intercept({ path: '/pypi/mcp/json' })
      .reply(200, JSON.stringify(PROJECT), {
        headers: { 'content-type': 'application/json', etag: '"project-etag"' },
      })
      .times(1);
    statsPool
      .intercept({ path: '/api/packages/mcp/recent' })
      .reply(200, JSON.stringify(RECENT), {
        headers: { 'content-type': 'application/json' },
      })
      .times(1);

    const refs: DiscoveredRef[] = [];
    for await (const page of adapter.discover(context(registryBucket), { maxItems: 1 })) {
      refs.push(...page);
    }

    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      source: 'pypi',
      kind: 'package',
      externalId: 'mcp',
      hint: { reason: 'seed', rank: 0 },
      raw: { kind: 'metadata' },
    });
    expect(registryBucket.takes).toEqual([1, 1, 1]);
    expect(statsBucket.takes).toEqual([1]);
  });

  it('filters RSS items by name/summary keywords and admits on weekly downloads', async () => {
    const { adapter, registryBucket, statsBucket } = harness();
    pypiPool
      .intercept({ path: '/rss/packages.xml' })
      .reply(
        200,
        feed(feedItem('mcp', 'Model Context Protocol'), feedItem('plainpkg', 'a database helper')),
      )
      .times(1);
    pypiPool.intercept({ path: '/rss/updates.xml' }).reply(200, EMPTY_FEED).times(1);
    pypiPool
      .intercept({ path: '/pypi/mcp/json' })
      .reply(200, JSON.stringify(PROJECT), { headers: { 'content-type': 'application/json' } })
      .times(1);
    statsPool
      .intercept({ path: '/api/packages/mcp/recent' })
      .reply(200, JSON.stringify(RECENT), { headers: { 'content-type': 'application/json' } })
      .times(1);

    const refs: DiscoveredRef[] = [];
    for await (const page of adapter.discover(context(registryBucket), { maxItems: 10 })) {
      refs.push(...page);
    }

    expect(refs.map((entry) => entry.externalId)).toEqual(['mcp']);
    expect(refs[0]?.hint).toMatchObject({ reason: 'rss', query: 'newest', rank: 0 });
    expect(refs[0]?.raw).toMatchObject({ kind: 'metadata' });
    expect(statsBucket.takes).toEqual([1]);
  });

  it('admits a brand-new project without calling pypistats', async () => {
    const { adapter, registryBucket, statsBucket } = harness();
    const fresh = {
      info: { name: 'agent-fresh', summary: 'new agent SDK', project_urls: {} },
      releases: {
        '0.1.0': [{ upload_time_iso_8601: '2026-10-19T00:00:00Z' }],
      },
    };
    pypiPool
      .intercept({ path: '/rss/packages.xml' })
      .reply(200, feed(feedItem('agent-fresh', 'agent SDK')))
      .times(1);
    pypiPool.intercept({ path: '/rss/updates.xml' }).reply(200, EMPTY_FEED).times(1);
    pypiPool
      .intercept({ path: '/pypi/agent-fresh/json' })
      .reply(200, JSON.stringify(fresh), { headers: { 'content-type': 'application/json' } })
      .times(1);

    const refs: DiscoveredRef[] = [];
    for await (const page of adapter.discover(context(registryBucket), { maxItems: 10 })) {
      refs.push(...page);
    }

    expect(refs.map((entry) => entry.externalId)).toEqual(['agent-fresh']);
    expect(statsBucket.takes).toEqual([]);
  });
});

describe('PyPI fetchMetrics — daily (spec §7.3.3)', () => {
  it('fetches overall?mirrors=false and keeps the last three without_mirrors days', async () => {
    const { adapter, registryBucket, statsBucket } = harness();
    statsPool
      .intercept({
        path: new URL(overallStatsUrl('mcp')).pathname + new URL(overallStatsUrl('mcp')).search,
      })
      .reply(200, JSON.stringify(OVERALL), { headers: { 'content-type': 'application/json' } })
      .times(1);

    const fetched = await adapter.fetchMetrics(context(registryBucket), [ref('MCP')], {
      tier: 'warm',
      mode: 'daily',
    });
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.dailyIncomplete).toBeUndefined();
    expect(fetched[0]?.raw).toMatchObject({ kind: 'downloads', latestDay: '2026-10-19' });
    const raw = fetched[0]?.raw;
    if (raw?.kind !== 'downloads') throw new Error('expected a downloads payload');
    expect(raw.points.map((point) => point.date)).toEqual([
      '2026-10-17',
      '2026-10-18',
      '2026-10-19',
    ]);
    expect(statsBucket.takes).toEqual([1]);
    expect(registryBucket.takes).toEqual([]);
  });

  it('marks a run partial when the expected latest day is absent', async () => {
    const { adapter, registryBucket } = harness();
    const stale = {
      ...OVERALL,
      data: OVERALL.data.filter((point) => point.date <= '2026-10-18'),
    };
    statsPool
      .intercept({ path: '/api/packages/mcp/overall?mirrors=false' })
      .reply(200, JSON.stringify(stale), { headers: { 'content-type': 'application/json' } })
      .times(1);

    const fetched = await adapter.fetchMetrics(context(registryBucket), [ref('mcp')], {
      tier: 'warm',
      mode: 'daily',
    });
    expect(fetched[0]?.dailyIncomplete).toBe(true);
    const raw = fetched[0]?.raw;
    if (raw?.kind !== 'downloads') throw new Error('expected a downloads payload');
    expect(raw.points.at(-1)?.date).toBe('2026-10-18');
  });

  it('treats a pypistats 404 as an item with no daily rows, not a failure', async () => {
    const { adapter, registryBucket } = harness();
    statsPool
      .intercept({ path: '/api/packages/newpkg/overall?mirrors=false' })
      .reply(404, '404', { headers: { 'content-type': 'text/plain' } })
      .times(1);

    const fetched = await adapter.fetchMetrics(context(registryBucket), [ref('newpkg')], {
      tier: 'warm',
      mode: 'daily',
    });
    expect(fetched[0]?.notFound).toBeUndefined();
    expect(fetched[0]?.dailyIncomplete).toBeUndefined();
    expect(fetched[0]?.raw).toEqual({ kind: 'downloads', points: [], latestDay: null });
  });
});

describe('PyPI fetchMetrics — project refresh (spec §7.3.3)', () => {
  it('sends If-None-Match from the Redis ETag and stores the new ETag', async () => {
    const { adapter, registryBucket, etags } = harness();
    etags.values.set('mcp', '"old-etag"');
    let seenIfNoneMatch: string | undefined;
    pypiPool
      .intercept({ path: '/pypi/mcp/json' })
      .reply((opts) => {
        seenIfNoneMatch = header(opts.headers, 'if-none-match');
        return {
          statusCode: 200,
          data: JSON.stringify(PROJECT),
          responseOptions: { headers: { 'content-type': 'application/json', etag: '"new-etag"' } },
        };
      })
      .times(1);

    const fetched = await adapter.fetchMetrics(context(registryBucket), [ref('mcp')], {
      tier: 'warm',
    });
    expect(seenIfNoneMatch).toBe('"old-etag"');
    expect(fetched[0]?.raw).toMatchObject({ kind: 'metadata' });
    expect(etags.sets).toEqual([{ project: 'mcp', etag: '"new-etag"' }]);
  });

  it('maps 304 to notModified and 404 to notFound', async () => {
    const { adapter, registryBucket, etags } = harness();
    etags.values.set('mcp', '"cached"');
    pypiPool
      .intercept({ path: '/pypi/mcp/json' })
      .reply(304, '', { headers: { etag: '"cached"' } })
      .times(1);
    pypiPool.intercept({ path: '/pypi/missing/json' }).reply(404, 'missing').times(1);

    const fetched = await adapter.fetchMetrics(
      context(registryBucket),
      [ref('mcp'), ref('missing')],
      { tier: 'warm' },
    );
    expect(fetched[0]?.notModified).toBe(true);
    expect(fetched[1]?.notFound).toBe(true);
    expect(etags.sets).toEqual([]);
  });
});

describe('PyPI backfill (spec §7.3.3)', () => {
  it('keeps the newest 60 rows of the existing pypistats series', async () => {
    const { adapter, registryBucket, statsBucket } = harness();
    statsPool
      .intercept({ path: '/api/packages/mcp/overall?mirrors=false' })
      .reply(200, JSON.stringify(OVERALL), { headers: { 'content-type': 'application/json' } })
      .times(1);

    if (adapter.backfill === undefined) throw new Error('pypi adapter must implement backfill');
    const rows = await adapter.backfill(context(registryBucket), ref('MCP'), 999);
    expect(rows).toHaveLength(60);
    expect(rows[0]?.day).toBe('2026-08-21');
    expect(rows.at(-1)?.day).toBe('2026-10-19');
    expect(rows.at(-1)?.value).toBe(
      OVERALL.data.filter((point) => point.category === 'without_mirrors').at(-1)?.downloads,
    );
    expect(statsBucket.takes).toEqual([1]);
  });
});
