import { readFileSync } from 'node:fs';

import { createLogger } from '@trendr/logger';
import { UpstreamError } from '@trendr/core';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdapterContext, DiscoveredRef } from '../adapter.js';
import {
  createArxivAdapter,
  createLocalArxivConnectionLock,
  type ArxivBucketLike,
} from './arxiv.adapter.js';
import { HfDailyPapersSchema, HfPaperSchema } from './schemas.js';
import { arxivQueryUrl, hfDailyPapersUrl, hfPaperUrl, shiftUtcDay, utcDay } from './urls.js';

/**
 * Spec §18 task 5.4 — discovery pagination/cutoff + fake-timer politeness, the
 * Atom error feed, and HF upvotes enrichment from daily feeds/detail fallback.
 */

const NOW = new Date('2026-10-20T12:00:00Z');
const ARXIV = 'https://export.arxiv.org';
const HF = 'https://huggingface.co';

function readText(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
}

function readJson(name: string): unknown {
  return JSON.parse(readText(name)) as unknown;
}

const PAGE_XML = readText('atom-page.xml');
const ERROR_XML = readText('atom-error.xml');
const DAILY = HfDailyPapersSchema.parse(readJson('hf-daily-papers.json'));
const PAPER = HfPaperSchema.parse(readJson('hf-paper.json'));

interface FakeBucket extends ArxivBucketLike {
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

/** A fake `arxiv:api` bucket that enforces the 3 s spacing with real timers. */
function spacedBucket(): FakeBucket {
  const bucket = fakeBucket();
  let last: number | null = null;
  bucket.take = async (cost) => {
    bucket.takes.push(cost ?? 1);
    if (last !== null) {
      const wait = last + 3_000 - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    last = Date.now();
  };
  return bucket;
}

function context(
  bucket: FakeBucket,
  overrides: Partial<AdapterContext> = {},
  now: () => Date = () => NOW,
): AdapterContext {
  return {
    logger: createLogger({ service: 'worker', level: 'error' }),
    bucket: bucket as unknown as AdapterContext['bucket'],
    signal: new AbortController().signal,
    now,
    runId: 11n,
    ...overrides,
  };
}

function harness(overrides: Partial<Parameters<typeof createArxivAdapter>[0]> = {}): {
  adapter: ReturnType<typeof createArxivAdapter>;
  arxivBucket: FakeBucket;
  hfBucket: FakeBucket;
} {
  const arxivBucket = fakeBucket();
  const hfBucket = fakeBucket();
  const adapter = createArxivAdapter({
    userAgent: 'Trendr-Test/1.0',
    hfBucket,
    connectionLock: createLocalArxivConnectionLock(),
    ...overrides,
  });
  return { adapter, arxivBucket, hfBucket };
}

async function collectDiscover(
  adapter: ReturnType<typeof createArxivAdapter>,
  ctx: AdapterContext,
  opts: { maxItems: number; strategy?: string } = { maxItems: 10 },
): Promise<DiscoveredRef[]> {
  const refs: DiscoveredRef[] = [];
  for await (const page of adapter.discover(ctx, opts)) refs.push(...page);
  return refs;
}

function atomEntry(id: string, title: string, published: string): string {
  return (
    `<entry><id>http://arxiv.org/abs/${id}</id><title>${title}</title>` +
    `<published>${published}</published><updated>${published}</updated>` +
    `<summary>${title} abstract</summary>` +
    `<author><name>Ada Lovelace</name></author>` +
    `<category term="cs.AI" scheme="http://arxiv.org/schemas/atom"/>` +
    `<arxiv:primary_category term="cs.AI"/></entry>`
  );
}

function atomFeed(entries: readonly string[]): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom"><title>arXiv Query</title>${entries.join('')}</feed>`;
}

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

const originalDispatcher: Dispatcher = getGlobalDispatcher();
let agent: MockAgent;
let arxivPool: ReturnType<MockAgent['get']>;
let hfPool: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  arxivPool = agent.get(ARXIV);
  hfPool = agent.get(HF);
});

afterEach(async () => {
  vi.useRealTimers();
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
});

describe('arXiv discovery (spec §7.3.5)', () => {
  it('parses a page into refs with the full Atom entry attached', async () => {
    const { adapter, arxivBucket, hfBucket } = harness();
    arxivPool
      .intercept({ path: pathOf(arxivQueryUrl(0, 200)) })
      .reply(200, PAGE_XML, { headers: { 'content-type': 'application/atom+xml' } })
      .times(1);

    const refs = await collectDiscover(adapter, context(arxivBucket));

    expect(refs.map((ref) => ref.externalId)).toEqual(['2610.26863', '2610.26860', '2610.26861']);
    expect(refs[0]).toMatchObject({
      source: 'arxiv',
      kind: 'paper',
      hint: { reason: 'new-listings', rank: 0 },
      raw: { kind: 'atom' },
    });
    expect(arxivBucket.takes).toEqual([1]);
    expect(hfBucket.takes).toEqual([]);
  });

  it('makes three sequential requests at least 6 s apart (fake timers)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { adapter } = harness({ pageSize: 2, maxPages: 5 });
    const recentOne = '2026-10-20T00:00:00Z';
    const recentTwo = '2026-10-19T23:00:00Z';
    const recentThree = '2026-10-19T22:00:00Z';
    const recentFour = '2026-10-19T21:00:00Z';
    const old = '2026-10-16T00:00:00Z';

    arxivPool
      .intercept({ path: pathOf(arxivQueryUrl(0, 2)) })
      .reply(
        200,
        atomFeed([
          atomEntry('2610.10001v1', 'First', recentOne),
          atomEntry('2610.10002v1', 'Second', recentTwo),
        ]),
      )
      .times(1);
    arxivPool
      .intercept({ path: pathOf(arxivQueryUrl(2, 2)) })
      .reply(
        200,
        atomFeed([
          atomEntry('2610.10003v1', 'Third', recentThree),
          atomEntry('2610.10004v1', 'Fourth', recentFour),
        ]),
      )
      .times(1);
    arxivPool
      .intercept({ path: pathOf(arxivQueryUrl(4, 2)) })
      .reply(200, atomFeed([atomEntry('2610.10005v1', 'Old', old)]))
      .times(1);

    const bucket = spacedBucket();
    const run = collectDiscover(
      adapter,
      context(bucket, {}, () => new Date()),
    );
    await vi.runAllTimersAsync();
    const refs = await run;

    expect(refs.map((ref) => ref.externalId)).toEqual([
      '2610.10001',
      '2610.10002',
      '2610.10003',
      '2610.10004',
    ]);
    expect(bucket.takes).toHaveLength(3);
    expect(Date.now() - NOW.getTime()).toBeGreaterThanOrEqual(6_000);
  });

  it('fails non-retryably on the Atom error feed', async () => {
    const { adapter, arxivBucket } = harness();
    arxivPool
      .intercept({ path: pathOf(arxivQueryUrl(0, 200)) })
      .reply(200, ERROR_XML, { headers: { 'content-type': 'application/atom+xml' } })
      .times(1);

    await expect(collectDiscover(adapter, context(arxivBucket))).rejects.toMatchObject({
      source: 'arxiv',
      retryable: false,
    });
  });

  it('rejects an unsupported discovery strategy without making a request', async () => {
    const { adapter, arxivBucket } = harness();
    await expect(
      collectDiscover(adapter, context(arxivBucket), { maxItems: 10, strategy: 'relevance' }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(arxivBucket.takes).toEqual([]);
  });
});

describe('arXiv HF upvotes enrichment (spec §7.3.5)', () => {
  function interceptFeeds(today: readonly unknown[], yesterday: readonly unknown[]): void {
    hfPool
      .intercept({ path: pathOf(hfDailyPapersUrl(utcDay(NOW))) })
      .reply(200, JSON.stringify(today), { headers: { 'content-type': 'application/json' } })
      .times(1);
    hfPool
      .intercept({ path: pathOf(hfDailyPapersUrl(utcDay(shiftUtcDay(NOW, -1)))) })
      .reply(200, JSON.stringify(yesterday), { headers: { 'content-type': 'application/json' } })
      .times(1);
  }

  it('uses today/yesterday daily papers and a detail fallback for the rest', async () => {
    const { adapter, arxivBucket, hfBucket } = harness();
    const fallbackPaper = HfPaperSchema.parse({
      ...PAPER,
      id: '2610.99999',
      upvotes: 7,
      githubRepo: null,
      githubStars: 0,
    });
    interceptFeeds([DAILY[1]], [DAILY[0]]);
    hfPool
      .intercept({ path: pathOf(hfPaperUrl('2610.99999')) })
      .reply(200, JSON.stringify(fallbackPaper), {
        headers: { 'content-type': 'application/json' },
      })
      .times(1);

    const ctx = context(arxivBucket);
    const refs: DiscoveredRef[] = [
      { source: 'arxiv', kind: 'paper', externalId: '2610.22471', itemId: 1n },
      { source: 'arxiv', kind: 'paper', externalId: '2610.20424', itemId: 2n },
      { source: 'arxiv', kind: 'paper', externalId: '2610.99999', itemId: 3n },
    ];
    const fetched = await adapter.fetchMetrics(ctx, refs, { tier: 'hot', mode: 'snapshot' });

    expect(fetched.map((item) => item.ref.externalId)).toEqual([
      '2610.22471',
      '2610.20424',
      '2610.99999',
    ]);
    expect(fetched[0]?.raw).toMatchObject({ kind: 'hf-daily' });
    expect(fetched[1]?.raw).toMatchObject({ kind: 'hf-daily' });
    expect(fetched[2]?.raw).toMatchObject({ kind: 'hf-detail', paper: { upvotes: 7 } });
    expect(hfBucket.takes).toEqual([1, 1, 1]);
  });

  it('caches the daily feeds across batches from the same adapter', async () => {
    const { adapter, arxivBucket, hfBucket } = harness();
    interceptFeeds([DAILY[0]], []);
    const first = await adapter.fetchMetrics(
      context(arxivBucket),
      [{ source: 'arxiv', kind: 'paper', externalId: '2610.22471' }],
      { tier: 'hot', mode: 'snapshot' },
    );
    expect(first).toHaveLength(1);
    expect(hfBucket.takes).toEqual([1, 1]);

    const second = await adapter.fetchMetrics(
      context(arxivBucket),
      [{ source: 'arxiv', kind: 'paper', externalId: '2610.22471' }],
      { tier: 'hot', mode: 'snapshot' },
    );
    expect(second[0]?.raw).toMatchObject({ kind: 'hf-daily' });
    expect(hfBucket.takes).toEqual([1, 1]);
  });

  it('leaves a paper untouched when HF has no entry (404)', async () => {
    const { adapter, arxivBucket, hfBucket } = harness();
    interceptFeeds([], []);
    hfPool
      .intercept({ path: pathOf(hfPaperUrl('2610.12345')) })
      .reply(404, '')
      .times(1);

    const fetched = await adapter.fetchMetrics(
      context(arxivBucket),
      [{ source: 'arxiv', kind: 'paper', externalId: '2610.12345' }],
      { tier: 'hot', mode: 'snapshot' },
    );
    expect(fetched).toEqual([]);
    expect(hfBucket.takes).toEqual([1, 1, 1]);

    // A second snapshot in the same process must not spend another detail
    // call on a known-404 paper (feeds are still cached too).
    const second = await adapter.fetchMetrics(
      context(arxivBucket),
      [{ source: 'arxiv', kind: 'paper', externalId: '2610.12345' }],
      { tier: 'hot', mode: 'snapshot' },
    );
    expect(second).toEqual([]);
    expect(hfBucket.takes).toEqual([1, 1, 1]);
  });

  it('defers detail calls after the hourly budget and marks them for continuity', async () => {
    const { adapter, arxivBucket, hfBucket } = harness({ detailBudgetPerHour: 1 });
    interceptFeeds([], []);
    hfPool
      .intercept({ path: pathOf(hfPaperUrl('2610.11111')) })
      .reply(200, JSON.stringify({ ...PAPER, id: '2610.11111' }), {
        headers: { 'content-type': 'application/json' },
      })
      .times(1);

    const fetched = await adapter.fetchMetrics(
      context(arxivBucket),
      [
        { source: 'arxiv', kind: 'paper', externalId: '2610.11111' },
        { source: 'arxiv', kind: 'paper', externalId: '2610.22222' },
      ],
      { tier: 'hot', mode: 'snapshot' },
    );
    expect(fetched).toHaveLength(2);
    expect(fetched[0]?.notModified).toBeUndefined();
    expect(fetched[1]?.notModified).toBe(true);
    expect(hfBucket.takes).toEqual([1, 1, 1]);
  });

  it('does not call HF at all for a daily-mode job', async () => {
    const { adapter, arxivBucket, hfBucket } = harness();
    const fetched = await adapter.fetchMetrics(
      context(arxivBucket),
      [{ source: 'arxiv', kind: 'paper', externalId: '2610.22471' }],
      { tier: 'hot', mode: 'daily' },
    );
    expect(fetched).toEqual([]);
    expect(hfBucket.takes).toEqual([]);
  });
});
