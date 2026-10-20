import { readFileSync } from 'node:fs';

import { createLogger } from '@trendr/logger';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterContext, DiscoveredRef } from '../adapter.js';
import { createHuggingFaceAdapter, type HuggingFaceAdapterConfig } from './huggingface.adapter.js';
import { normalizeHuggingFaceItem, type HfRepo } from './normalize.js';
import {
  hfDetailUrl,
  hfListUrl,
  hfNextLink,
  HF_DETAIL_EXPANDS,
  HF_LIST_EXPANDS,
  HF_NEWEST_MIN_LIKES,
} from './urls.js';

/**
 * Spec §18 task 5.3 — HF list pages with `expand[]` + `Link` cursor,
 * list-as-snapshot, detail fallback, per-kind field sets, `RateLimit` `t=`
 * pause, `arxiv:` aliases and the optional datasets/spaces phases.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const HF = 'https://huggingface.co';
const POOL = `${HF}/api`;

interface FakeBucket {
  takes: number[];
  pauses: number[];
  take(cost?: number): Promise<void>;
  pauseUntil(until: number): Promise<void>;
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
    runId: 9n,
    ...overrides,
  };
}

function modelRef(repoId = 'google-bert/bert-base-uncased'): DiscoveredRef {
  return { source: 'huggingface', kind: 'model', externalId: `models/${repoId}` };
}

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const MODEL_LIST = readFixture('model-list.json') as HfRepo[];
const MODEL_DETAIL = readFixture('model-detail.json') as HfRepo;
const DATASET_LIST = readFixture('dataset-list.json') as HfRepo[];
const SPACE_LIST = readFixture('space-list.json') as HfRepo[];
const META = readFixture('meta.json') as {
  rateLimit: string;
  modelListLink: string;
  evidence: { modelDetailArxivTags: string[] };
};

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function adapter(
  config: Partial<HuggingFaceAdapterConfig> = {},
): ReturnType<typeof createHuggingFaceAdapter> {
  return createHuggingFaceAdapter({
    userAgent: 'Trendr/test (+https://example.test)',
    ...config,
  });
}

async function drain(iterable: AsyncIterable<unknown>): Promise<void> {
  for await (const page of iterable) {
    expect(page).toBeDefined();
  }
}

function replyJson(
  pool: ReturnType<MockAgent['get']>,
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  pool
    .intercept({ path: pathOf(url) })
    .reply(200, JSON.stringify(body), {
      headers: { 'content-type': 'application/json', ...headers },
    })
    .times(1);
}

const originalDispatcher: Dispatcher = getGlobalDispatcher();
let agent: MockAgent;
let pool: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  pool = agent.get(HF);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
  vi.useRealTimers();
});

describe('HF normalization (spec §7.3.4)', () => {
  it('normalizes a model detail: cumulative snapshots, latest-only rolling downloads and arxiv alias', () => {
    const normalized = normalizeHuggingFaceItem({
      ref: modelRef(),
      raw: { kind: 'detail', repo: MODEL_DETAIL },
      fetchedAt: NOW,
    });
    expect(normalized).not.toBeNull();
    if (normalized === null) throw new Error('expected normalized model');

    expect(normalized.item).toMatchObject({
      source: 'huggingface',
      kind: 'model',
      externalId: 'models/google-bert/bert-base-uncased',
      upstreamId: '621ffdc036468d709f174338',
      name: 'bert-base-uncased',
      displayName: 'google-bert/bert-base-uncased',
      description: null,
      url: 'https://huggingface.co/google-bert/bert-base-uncased',
      homepage: null,
      language: null,
      license: 'Apache-2.0',
      owner: 'google-bert',
      primaryMetric: 'likes',
      isArchived: false,
    });
    expect(normalized.item.topics).toEqual(
      expect.arrayContaining(['transformers', 'bert', 'fill-mask']),
    );
    expect(normalized.snapshots).toEqual([
      { metric: 'likes', value: 3041 },
      { metric: 'downloads_total', value: 3267215234 },
      // The fixture's 1.5 is rounded because snapshots.value is bigint (§5.2).
      { metric: 'trending_score', value: 2 },
    ]);
    expect(normalized.latestMetrics).toEqual({ downloads: 30160565 });
    expect(normalized.snapshots.some((point) => point.metric === 'downloads')).toBe(false);
    expect(normalized.aliases).toEqual([
      {
        source: 'arxiv',
        kind: 'paper',
        externalId: '1810.04805',
        relation: 'model_of_paper',
        confidence: 0.9,
        evidence: 'huggingface.tags.arxiv',
      },
    ]);
    expect(META.evidence.modelDetailArxivTags).toContain('arxiv:1810.04805');
  });

  it('normalizes a list-as-snapshot payload without a detail call', () => {
    const repo = MODEL_LIST[0];
    if (repo === undefined) throw new Error('model-list fixture is empty');
    const normalized = normalizeHuggingFaceItem({
      ref: modelRef(repo.id),
      raw: { kind: 'list', repo },
      fetchedAt: NOW,
    });
    expect(normalized?.snapshots).toEqual(
      expect.arrayContaining([
        { metric: 'likes', value: repo.likes },
        { metric: 'downloads_total', value: repo.downloadsAllTime },
        { metric: 'trending_score', value: repo.trendingScore },
      ]),
    );
    expect(normalized?.latestMetrics).toEqual({ downloads: repo.downloads });
  });

  it('uses dataset/spaces field sets and never invents space downloads', () => {
    const dataset = DATASET_LIST[0];
    const space = SPACE_LIST[0];
    if (dataset === undefined || space === undefined) throw new Error('fixtures are empty');

    const normalizedDataset = normalizeHuggingFaceItem({
      ref: { source: 'huggingface', kind: 'dataset', externalId: `datasets/${dataset.id}` },
      raw: { kind: 'list', repo: dataset },
      fetchedAt: NOW,
    });
    expect(normalizedDataset?.item).toMatchObject({
      kind: 'dataset',
      url: `https://huggingface.co/datasets/${dataset.id}`,
      license: 'CC-BY-NC-4.0',
      primaryMetric: 'likes',
    });
    expect(normalizedDataset?.latestMetrics).toEqual({ downloads: dataset.downloads });
    expect(normalizedDataset?.snapshots).toEqual(
      expect.arrayContaining([{ metric: 'downloads_total', value: dataset.downloadsAllTime }]),
    );

    const normalizedSpace = normalizeHuggingFaceItem({
      ref: { source: 'huggingface', kind: 'space', externalId: `spaces/${space.id}` },
      raw: { kind: 'list', repo: space },
      fetchedAt: NOW,
    });
    expect(normalizedSpace?.item.url).toBe(`https://huggingface.co/spaces/${space.id}`);
    expect(normalizedSpace?.snapshots).toEqual([
      { metric: 'likes', value: space.likes },
      { metric: 'trending_score', value: space.trendingScore },
    ]);
    expect(normalizedSpace?.latestMetrics).toBeUndefined();
    expect(normalizedSpace?.item.topics).toEqual(expect.arrayContaining(['gradio', 'mcp']));
    expect(normalizedSpace?.item.metadata).toMatchObject({ sdk: 'gradio' });
  });

  it('maps gated/disabled flags, strips arxiv versions and ignores malformed tags', () => {
    const normalized = normalizeHuggingFaceItem({
      ref: modelRef('acme/gated'),
      raw: {
        kind: 'detail',
        repo: {
          id: 'acme/gated',
          likes: 5,
          gated: 'auto',
          disabled: true,
          tags: ['license:mit', 'arxiv:1810.04805v3', 'arxiv:1810.04805', 'transformer'],
        },
      },
      fetchedAt: NOW,
    });
    expect(normalized?.item.flags).toEqual(['gated']);
    expect(normalized?.item.isArchived).toBe(true);
    expect(normalized?.item.license).toBe('MIT');
    expect(normalized?.aliases.map((alias) => alias.externalId)).toEqual(['1810.04805']);
  });
});

describe('HF discovery (spec §7.3.4)', () => {
  it('follows the Link cursor, caps at maxItems and caches list pages for snapshots', async () => {
    const bucket = fakeBucket();
    const hf = adapter({ trendingPages: 2, newestPages: 0 });
    const firstUrl = hfListUrl('model', 'trendingScore', 100);
    const nextUrl = `${POOL}/models?sort=trendingScore&direction=-1&limit=100&cursor=next-page`;
    const second = { ...MODEL_DETAIL, id: 'acme/second', _id: 'acme-second', likes: 42 };
    replyJson(pool, firstUrl, MODEL_LIST, {
      link: `<${nextUrl}>; rel="next"`,
    });
    replyJson(pool, nextUrl, [second]);

    const seen: DiscoveredRef[] = [];
    for await (const page of hf.discover(context(bucket), { maxItems: 3 })) {
      seen.push(...page);
    }

    expect(hfNextLink(new Headers({ link: META.modelListLink }))).toContain('cursor=');
    expect(seen.map((entry) => entry.externalId)).toEqual([
      `models/${MODEL_LIST[0]?.id}`,
      `models/${MODEL_LIST[1]?.id}`,
      'models/acme/second',
    ]);
    expect(seen.map((entry) => entry.hint?.reason)).toEqual(['trending', 'trending', 'trending']);
    expect(bucket.takes).toEqual([1, 1]);

    // Same-hour snapshot uses the cached list payload: no detail request.
    const firstRef = seen[0];
    if (firstRef === undefined) throw new Error('expected a discovered ref');
    const cached = await hf.fetchMetrics(context(bucket), [firstRef], { tier: 'hot' });
    expect(cached[0]?.raw).toMatchObject({ kind: 'list' });
    expect(bucket.takes).toHaveLength(2);
  });

  it('applies likes ≥ 5 to the newest phase and keeps the per-kind expand sets', async () => {
    const bucket = fakeBucket();
    const hf = adapter({ trendingPages: 0, newestPages: 1 });
    const newestUrl = hfListUrl('model', 'createdAt', 100);
    replyJson(pool, newestUrl, [
      { ...MODEL_DETAIL, id: 'acme/popular-new', likes: HF_NEWEST_MIN_LIKES },
      { ...MODEL_DETAIL, id: 'acme/quiet-new', likes: HF_NEWEST_MIN_LIKES - 1 },
    ]);

    const seen: DiscoveredRef[] = [];
    for await (const page of hf.discover(context(bucket), { maxItems: 10 })) {
      seen.push(...page);
    }

    expect(seen.map((entry) => entry.externalId)).toEqual(['models/acme/popular-new']);
    expect(newestUrl).toContain('expand[]=library_name');
    expect(newestUrl).toContain('expand[]=pipeline_tag');
    expect(newestUrl).not.toContain('expand[]=description');
  });

  it('adds optional datasets and spaces with their own sort/expand shape', async () => {
    const bucket = fakeBucket();
    const hf = adapter({
      trendingPages: 0,
      newestPages: 0,
      optionalPages: 1,
      includeDatasets: true,
      includeSpaces: true,
    });
    const datasetUrl = hfListUrl('dataset', 'trendingScore', 100);
    const spaceUrl = hfListUrl('space', 'trendingScore', 100);
    replyJson(pool, datasetUrl, DATASET_LIST);
    replyJson(pool, spaceUrl, SPACE_LIST);

    const seen: DiscoveredRef[] = [];
    for await (const page of hf.discover(context(bucket), { maxItems: 10 })) {
      seen.push(...page);
    }

    expect(seen.map((entry) => [entry.kind, entry.externalId])).toEqual([
      ['dataset', `datasets/${DATASET_LIST[0]?.id}`],
      ['space', `spaces/${SPACE_LIST[0]?.id}`],
    ]);
    expect(datasetUrl).toContain('expand[]=downloadsAllTime');
    expect(spaceUrl).toContain('expand[]=sdk');
    expect(spaceUrl).not.toContain('downloads');
    expect(datasetUrl).toBe(
      `${POOL}/datasets?sort=trendingScore&direction=-1&limit=100&${HF_LIST_EXPANDS.dataset
        .map((field) => `expand[]=${field}`)
        .join('&')}`,
    );
  });

  it('supports the daily likes strategy and rejects unknown strategies', async () => {
    const bucket = fakeBucket();
    const hf = adapter({ likesPages: 1 });
    const likesUrl = hfListUrl('model', 'likes', 100);
    replyJson(pool, likesUrl, MODEL_LIST.slice(0, 1));

    const seen: DiscoveredRef[] = [];
    for await (const page of hf.discover(context(bucket), { strategy: 'likes', maxItems: 10 })) {
      seen.push(...page);
    }
    expect(seen).toHaveLength(1);
    expect(likesUrl).toContain('sort=likes');

    await expect(
      drain(hf.discover(context(bucket), { strategy: 'unknown', maxItems: 1 })),
    ).rejects.toThrow(/unsupported huggingface discovery strategy/);
  });
});

describe('HF fetchMetrics (spec §7.3.4)', () => {
  it('falls back to one detail call with HF detail expands and maps 404', async () => {
    const bucket = fakeBucket();
    const hf = adapter();
    const detailUrl = hfDetailUrl('model', 'google-bert/bert-base-uncased');
    const missingUrl = hfDetailUrl('model', 'acme/missing');
    replyJson(pool, detailUrl, MODEL_DETAIL);
    pool
      .intercept({ path: pathOf(missingUrl) })
      .reply(404, JSON.stringify({ error: 'not found' }), {
        headers: { 'content-type': 'application/json' },
      })
      .times(1);

    const fetched = await hf.fetchMetrics(context(bucket), [modelRef(), modelRef('acme/missing')], {
      tier: 'warm',
    });

    expect(fetched[0]?.raw).toMatchObject({ kind: 'detail' });
    expect(fetched[0]?.notFound).toBeUndefined();
    expect(fetched[1]?.notFound).toBe(true);
    expect(bucket.takes).toEqual([1, 1]);
    expect(detailUrl).toContain('expand[]=downloadsAllTime');
    expect(detailUrl).not.toContain('expand[]=description');
    expect(HF_DETAIL_EXPANDS.model).toContain('gated');
  });

  it('maps a detail 304 to notModified for the continuity path', async () => {
    const bucket = fakeBucket();
    const hf = adapter();
    pool
      .intercept({ path: pathOf(hfDetailUrl('model', 'acme/unchanged')) })
      .reply(304, '', { headers: { etag: '"fixture"' } })
      .times(1);

    const fetched = await hf.fetchMetrics(context(bucket), [modelRef('acme/unchanged')], {
      tier: 'cold',
    });
    expect(fetched[0]?.notModified).toBe(true);
    expect(fetched[0]?.raw).toEqual({ kind: 'detail', repo: null });
  });

  it('sends the bearer token when configured, never the user agent as a token', async () => {
    const bucket = fakeBucket();
    const hf = adapter({ token: 'hf_fixture_token' });
    let seenAuthorization: string | undefined;
    pool
      .intercept({ path: pathOf(hfDetailUrl('space', 'enzostvs/deepsite')) })
      .reply((opts) => {
        const headers = new Headers(opts.headers);
        seenAuthorization = headers.get('authorization') ?? undefined;
        return {
          statusCode: 200,
          data: JSON.stringify(SPACE_LIST[0]),
          responseOptions: { headers: { 'content-type': 'application/json' } },
        };
      })
      .times(1);

    await hf.fetchMetrics(
      context(bucket),
      [{ source: 'huggingface', kind: 'space', externalId: 'spaces/enzostvs/deepsite' }],
      { tier: 'warm' },
    );
    expect(seenAuthorization).toBe('Bearer hf_fixture_token');
  });

  it('parses RateLimit t= on 429 and pauses the bucket until reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const bucket = fakeBucket();
    const onRateLimit = vi.fn();
    const hf = adapter();
    pool
      .intercept({ path: pathOf(hfDetailUrl('model', 'google-bert/bert-base-uncased')) })
      .reply(429, JSON.stringify({ error: 'rate limited' }), {
        headers: {
          'content-type': 'application/json',
          ratelimit: '"api";r=0;t=42',
          'ratelimit-policy': '"fixed window";"api";q=500;w=300',
        },
      })
      .times(1);

    await expect(
      hf.fetchMetrics(context(bucket, { onRateLimit }), [modelRef()], { tier: 'warm' }),
    ).rejects.toThrow(/rate limited/);

    expect(bucket.pauses).toEqual([NOW.getTime() + 42_000]);
    expect(onRateLimit).toHaveBeenCalledWith({
      resource: 'api',
      remaining: 0,
      resetAt: new Date(NOW.getTime() + 42_000),
    });
  });

  it('reports observed RateLimit headers on successful responses', async () => {
    const bucket = fakeBucket();
    const onRateLimit = vi.fn();
    const hf = adapter();
    replyJson(pool, hfDetailUrl('model', 'google-bert/bert-base-uncased'), MODEL_DETAIL, {
      ratelimit: META.rateLimit,
      'ratelimit-policy': '"fixed window";"api";q=500;w=300',
    });

    await hf.fetchMetrics(context(bucket, { onRateLimit }), [modelRef()], { tier: 'warm' });
    expect(onRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ resource: 'api', remaining: 499 }),
    );
  });
});
