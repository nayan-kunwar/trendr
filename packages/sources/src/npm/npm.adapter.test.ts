import { readFileSync } from 'node:fs';

import { createLogger } from '@trendr/logger';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdapterContext, DiscoveredRef } from '../adapter.js';
import { createNpmAdapter, rotatedNpmKeywords, type NpmBucketLike } from './npm.adapter.js';
import { searchUrl } from './downloads.js';

/**
 * Spec §18 task 5.1 — npm request shapes: 250-item keyword search with the
 * admission filter, `last-day` anchored daily ranges, bulk ≤ 128 unscoped,
 * one encoded request per scoped package, full packuments on refresh and the
 * 60-day backfill.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org';

const WATERMARK = {
  downloads: 22_430_010,
  start: '2026-10-18',
  end: '2026-10-18',
  package: 'react',
};

function readJson(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

interface FakeBucket extends NpmBucketLike {
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
  return { source: 'npm', kind: 'package', externalId };
}

function searchPath(keyword: string, from: number): string {
  const url = new URL(searchUrl(keyword, from));
  return `${url.pathname}${url.search}`;
}

function searchPackage(
  name: string,
  weekly: number,
  date: string,
  repository?: string,
): Record<string, unknown> {
  return {
    package: {
      name,
      version: '1.0.0',
      description: `${name} description`,
      date,
      keywords: ['mcp', 'agent'],
      links: repository === undefined ? {} : { repository },
      license: 'MIT',
      publisher: { username: 'publisher' },
    },
    downloads: { monthly: weekly * 4, weekly },
    updated: date,
  };
}

function range(
  name: string,
  points: readonly (readonly [day: string, downloads: number])[],
): Record<string, unknown> {
  return {
    start: points[0]?.[0] ?? '',
    end: points.at(-1)?.[0] ?? '',
    package: name,
    downloads: points.map(([day, downloads]) => ({ day, downloads })),
  };
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

const originalDispatcher: Dispatcher = getGlobalDispatcher();
let agent: MockAgent;
let registryPool: ReturnType<MockAgent['get']>;
let downloadsPool: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  registryPool = agent.get(REGISTRY);
  downloadsPool = agent.get(DOWNLOADS);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
});

describe('npm discovery (spec §7.3.2)', () => {
  it('asks for 250 keyword matches and applies the admission filter', async () => {
    const registryBucket = fakeBucket();
    const { adapter } = harness();
    const keyword = rotatedNpmKeywords(NOW)[0];
    if (keyword === undefined) throw new Error('npm keyword list is empty');

    const body = JSON.stringify({
      objects: [
        searchPackage('popular', 500, '2020-01-01T00:00:00Z'),
        searchPackage('old-quiet', 1, '2020-01-01T00:00:00Z'),
        searchPackage('fresh-quiet', 0, '2026-10-19T00:00:00Z'),
        searchPackage('popular', 500, '2026-10-19T00:00:00Z'),
      ],
    });
    let seenPath: string | undefined;
    registryPool
      .intercept({ path: searchPath(keyword, 0) })
      .reply((opts) => {
        seenPath = opts.path;
        return {
          statusCode: 200,
          data: body,
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(1);

    const refs: DiscoveredRef[] = [];
    for await (const batch of adapter.discover(context(registryBucket), { maxItems: 2 })) {
      refs.push(...batch);
    }

    expect(seenPath).toBe(searchPath(keyword, 0));
    expect(seenPath).toContain('size=250');
    expect(seenPath).toContain('from=0');
    expect(seenPath).toContain('text=keywords%3A');
    expect(refs.map((entry) => entry.externalId)).toEqual(['popular', 'fresh-quiet']);
    expect(refs.map((entry) => entry.hint?.rank)).toEqual([0, 2]);
    expect(refs.every((entry) => entry.hint?.query === keyword)).toBe(true);
    expect(refs[0]?.raw).toMatchObject({ kind: 'search' });
    expect(registryBucket.takes).toEqual([1]);
  });
});

describe('npm fetchMetrics — daily (spec §7.3.2)', () => {
  it('anchors on last-day, bulk-fetches unscoped names and encodes scoped ones', async () => {
    const registryBucket = fakeBucket();
    const { adapter, downloadsBucket } = harness();
    const ctx = context(registryBucket);

    downloadsPool
      .intercept({ path: '/downloads/point/last-day/react' })
      .reply(200, JSON.stringify(WATERMARK), { headers: { 'content-type': 'application/json' } })
      .times(1);
    downloadsPool
      .intercept({
        path: '/downloads/range/2026-10-16:2026-10-18/react,vue,typescript,unknown-pkg',
      })
      .reply(
        200,
        JSON.stringify({
          react: range('react', [
            ['2026-10-16', 100],
            ['2026-10-17', 110],
            ['2026-10-18', 120],
          ]),
          vue: range('vue', [
            ['2026-10-16', 10],
            ['2026-10-17', 11],
            ['2026-10-18', 12],
          ]),
          // The newest computed day is absent → the run must finish partial.
          typescript: range('typescript', [
            ['2026-10-16', 20],
            ['2026-10-17', 21],
          ]),
          'unknown-pkg': null,
        }),
        { headers: { 'content-type': 'application/json' } },
      )
      .times(1);
    downloadsPool
      .intercept({
        path: '/downloads/range/2026-10-16:2026-10-18/@modelcontextprotocol%2Fsdk',
      })
      .reply(
        200,
        JSON.stringify(
          range('@modelcontextprotocol/sdk', [
            ['2026-10-16', 7],
            ['2026-10-17', 8],
            ['2026-10-18', 9],
          ]),
        ),
        { headers: { 'content-type': 'application/json' } },
      )
      .times(1);

    const refs = [
      ref('react'),
      ref('@modelcontextprotocol/sdk'),
      ref('vue'),
      ref('typescript'),
      ref('unknown-pkg'),
    ];
    const fetched = await adapter.fetchMetrics(ctx, refs, { tier: 'warm', mode: 'daily' });

    expect(fetched.map((entry) => entry.ref.externalId)).toEqual([
      'react',
      '@modelcontextprotocol/sdk',
      'vue',
      'typescript',
      'unknown-pkg',
    ]);
    expect(fetched[0]?.dailyIncomplete).toBeUndefined();
    expect(fetched[1]?.dailyIncomplete).toBeUndefined();
    expect(fetched[3]?.dailyIncomplete).toBe(true);
    expect(fetched[4]?.notFound).toBe(true);
    expect(fetched[0]?.raw).toMatchObject({ kind: 'downloads', day: '2026-10-18' });

    const parsed = fetched[0]?.raw;
    if (parsed?.kind !== 'downloads') throw new Error('expected a downloads payload');
    expect(parsed.range?.downloads).toEqual([
      { day: '2026-10-16', downloads: 100 },
      { day: '2026-10-17', downloads: 110 },
      { day: '2026-10-18', downloads: 120 },
    ]);

    // last-day + one bulk + one scoped request; the registry bucket is idle.
    expect(downloadsBucket.takes).toHaveLength(3);
    expect(registryBucket.takes).toEqual([]);
  });

  it('uses one request per scoped package, never mixing it into the bulk list', async () => {
    const { adapter, downloadsBucket } = harness();
    downloadsPool
      .intercept({ path: '/downloads/point/last-day/react' })
      .reply(200, JSON.stringify(WATERMARK))
      .times(1);
    downloadsPool
      .intercept({ path: '/downloads/range/2026-10-16:2026-10-18/@a%2Fone' })
      .reply(200, JSON.stringify(range('@a/one', [['2026-10-18', 1]])))
      .times(1);
    downloadsPool
      .intercept({ path: '/downloads/range/2026-10-16:2026-10-18/@b%2Ftwo' })
      .reply(200, JSON.stringify(range('@b/two', [['2026-10-18', 2]])))
      .times(1);

    const fetched = await adapter.fetchMetrics(
      context(fakeBucket()),
      [ref('@a/one'), ref('@b/two')],
      {
        tier: 'warm',
        mode: 'daily',
      },
    );
    expect(fetched).toHaveLength(2);
    expect(fetched[0]?.dailyIncomplete).toBeUndefined();
    expect(fetched[1]?.dailyIncomplete).toBeUndefined();
    expect(downloadsBucket.takes).toHaveLength(3);
  });
});

describe('npm fetchMetrics — snapshot / refresh (spec §7.3.2)', () => {
  it('fetches the full packument, encodes scoped names and maps 404 to notFound', async () => {
    const { adapter, downloadsBucket } = harness();
    const packument = readJson('packument.json');
    registryPool
      .intercept({ path: '/is-number' })
      .reply(200, JSON.stringify(packument), { headers: { 'content-type': 'application/json' } })
      .times(1);
    registryPool
      .intercept({ path: '/@scope%2Fmissing' })
      .reply(404, JSON.stringify({ error: 'Not found' }), {
        headers: { 'content-type': 'application/json' },
      })
      .times(1);

    const fetched = await adapter.fetchMetrics(
      context(fakeBucket()),
      [ref('is-number'), ref('@scope/missing')],
      { tier: 'warm' },
    );
    expect(fetched).toHaveLength(2);
    expect(fetched[0]?.raw).toMatchObject({ kind: 'packument' });
    expect(fetched[0]?.notFound).toBeUndefined();
    expect(fetched[1]?.notFound).toBe(true);
    // No download calls on a refresh: the daily job owns the series.
    expect(downloadsBucket.takes).toEqual([]);
  });

  it('sends the configured user agent and no credentials', async () => {
    const { adapter } = harness();
    let seenHeaders: Headers | Record<string, string | string[]> | undefined;
    registryPool
      .intercept({ path: '/is-number' })
      .reply((opts) => {
        seenHeaders = opts.headers;
        return {
          statusCode: 200,
          data: JSON.stringify(readJson('packument.json')),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(1);

    await adapter.fetchMetrics(context(fakeBucket()), [ref('is-number')], { tier: 'warm' });
    expect(header(seenHeaders, 'user-agent')).toBe('Trendr-Test/1.0');
    expect(header(seenHeaders, 'authorization')).toBeUndefined();
  });
});

describe('npm backfill (spec §7.3.2)', () => {
  it('requests range/{D-60}:{D} in one call and maps points to daily rows', async () => {
    const { adapter, downloadsBucket } = harness();
    downloadsPool
      .intercept({ path: '/downloads/point/last-day/react' })
      .reply(200, JSON.stringify(WATERMARK))
      .times(1);
    downloadsPool
      .intercept({ path: '/downloads/range/2026-08-19:2026-10-18/is-number' })
      .reply(
        200,
        JSON.stringify(
          range('is-number', [
            ['2026-08-19', 5],
            ['2026-10-18', 42],
          ]),
        ),
      )
      .times(1);

    if (adapter.backfill === undefined) throw new Error('npm adapter must implement backfill');
    const rows = await adapter.backfill(context(fakeBucket()), ref('is-number'), 60);
    expect(rows).toEqual([
      { metric: 'downloads', day: '2026-08-19', value: 5 },
      { metric: 'downloads', day: '2026-10-18', value: 42 },
    ]);
    expect(downloadsBucket.takes).toHaveLength(2);
  });

  it('clamps longer requests at 60 days and encodes the scoped name', async () => {
    const { adapter } = harness();
    downloadsPool
      .intercept({ path: '/downloads/point/last-day/react' })
      .reply(200, JSON.stringify(WATERMARK))
      .times(1);
    downloadsPool
      .intercept({ path: '/downloads/range/2026-08-19:2026-10-18/@scope%2Fpkg' })
      .reply(200, JSON.stringify(range('@scope/pkg', [['2026-10-18', 3]])))
      .times(1);

    if (adapter.backfill === undefined) throw new Error('npm adapter must implement backfill');
    const rows = await adapter.backfill(context(fakeBucket()), ref('@scope/pkg'), 999);
    expect(rows).toEqual([{ metric: 'downloads', day: '2026-10-18', value: 3 }]);
  });
});

function harness(): {
  adapter: ReturnType<typeof createNpmAdapter>;
  downloadsBucket: FakeBucket;
} {
  const downloadsBucket = fakeBucket();
  const adapter = createNpmAdapter({
    userAgent: 'Trendr-Test/1.0',
    minWeeklyDownloads: 200,
    downloadsBucket,
  });
  return { adapter, downloadsBucket };
}
