import { readFileSync } from 'node:fs';

import { createLogger } from '@trendr/logger';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AdapterContext, DiscoveredRef } from '../adapter.js';
import { mcpGitHubSearchUrl, mcpNpmSearchUrl, mcpServersUrl } from './urls.js';
import type { McpCursorStore } from './cursor.js';
import { createMcpAdapter, type McpAdapterConfig } from './mcp.adapter.js';
import type { McpRaw } from './normalize.js';

const NOW = new Date('2026-10-20T14:00:00Z');
const REGISTRY_HOST = 'https://registry.modelcontextprotocol.io';
const GITHUB_HOST = 'https://api.github.com';
const NPM_HOST = 'https://registry.npmjs.org';

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

function memoryCursor(initial: Date | null = null): McpCursorStore & {
  value: Date | null;
  sets: Date[];
} {
  const store = {
    value: initial,
    sets: [] as Date[],
    get(): Promise<Date | null> {
      return Promise.resolve(store.value);
    },
    set(cursor: Date): Promise<void> {
      store.value = cursor;
      store.sets.push(cursor);
      return Promise.resolve();
    },
  };
  return store;
}

function context(overrides: Partial<AdapterContext> = {}): AdapterContext {
  return {
    logger: createLogger({ service: 'worker', level: 'error' }),
    bucket: fakeBucket() as unknown as AdapterContext['bucket'],
    signal: new AbortController().signal,
    now: () => NOW,
    runId: 11n,
    ...overrides,
  };
}

function adapter(
  config: Partial<McpAdapterConfig> & Pick<McpAdapterConfig, 'cursorStore'>,
): ReturnType<typeof createMcpAdapter> {
  return createMcpAdapter({
    userAgent: 'Trendr/test (+https://example.test)',
    npmBucket: fakeBucket(),
    ...config,
  });
}

async function collect(iterable: AsyncIterable<DiscoveredRef[]>): Promise<DiscoveredRef[]> {
  const refs: DiscoveredRef[] = [];
  for await (const page of iterable) refs.push(...page);
  return refs;
}

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

function replyJson(
  pool: ReturnType<MockAgent['get']>,
  url: string,
  body: unknown,
  status = 200,
): void {
  pool
    .intercept({ path: pathOf(url) })
    .reply(status, status === 200 ? JSON.stringify(body) : '', {
      headers: { 'content-type': 'application/json' },
    })
    .times(1);
}

function readFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8'),
  ) as unknown;
}

const REGISTRY = (readFixture('registry-entries.json') as { servers: unknown[] }).servers;
const GITHUB = (readFixture('github-search.json') as { items: unknown[] }).items;
const NPM = (readFixture('npm-search.json') as { objects: unknown[] }).objects;

const originalDispatcher: Dispatcher = getGlobalDispatcher();
let agent: MockAgent;
let registryPool: ReturnType<MockAgent['get']>;
let githubPool: ReturnType<MockAgent['get']>;
let npmPool: ReturnType<MockAgent['get']>;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
  registryPool = agent.get(REGISTRY_HOST);
  githubPool = agent.get(GITHUB_HOST);
  npmPool = agent.get(NPM_HOST);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await agent.close();
});

describe('MCP registry discovery (spec §7.3.6)', () => {
  it('walks cursor pages with updated_since and stores the max updatedAt watermark', async () => {
    const cursor = new Date('2026-09-01T00:00:00.000Z');
    const store = memoryCursor(cursor);
    const pageOne = { servers: REGISTRY.slice(0, 2), metadata: { count: 2, nextCursor: 'c1' } };
    const pageTwo = { servers: REGISTRY.slice(2), metadata: { count: 2 } };
    replyJson(
      registryPool,
      mcpServersUrl('https://registry.modelcontextprotocol.io/v0.1', {
        updatedSince: cursor,
        cursor: null,
        includeDeleted: true,
      }),
      pageOne,
    );
    replyJson(
      registryPool,
      mcpServersUrl('https://registry.modelcontextprotocol.io/v0.1', {
        updatedSince: cursor,
        cursor: 'c1',
        includeDeleted: true,
      }),
      pageTwo,
    );

    const refs = await collect(
      adapter({ cursorStore: store }).discover(context(), { maxItems: 10, strategy: 'registry' }),
    );
    expect(refs).toHaveLength(4);
    expect(refs.map((ref) => ref.externalId)).toEqual(
      REGISTRY.map((entry) => (entry as { server: { name: string } }).server.name),
    );
    expect(store.sets).toHaveLength(1);
    expect(store.value?.toISOString()).toBe('2026-09-09T10:35:53.194Z');
  });

  it('falls back from v0.1 to v0 on 404 and ignores the cursor for a full pass', async () => {
    const store = memoryCursor(new Date('2026-10-01T00:00:00Z'));
    const page = { servers: REGISTRY.slice(0, 1), metadata: { count: 1 } };
    replyJson(
      registryPool,
      mcpServersUrl('https://registry.modelcontextprotocol.io/v0.1', {
        includeDeleted: true,
      }),
      {},
      404,
    );
    replyJson(
      registryPool,
      mcpServersUrl('https://registry.modelcontextprotocol.io/v0', {
        includeDeleted: true,
      }),
      page,
    );

    const refs = await collect(
      adapter({ cursorStore: store }).discover(context(), { maxItems: 10, strategy: 'full' }),
    );
    expect(refs).toHaveLength(1);
    expect(store.sets).toHaveLength(1);
    expect(store.sets[0]?.toISOString()).toBe('2026-03-06T11:23:10.721Z');
  });

  it('does not advance the cursor when the discovery bound truncates a page walk', async () => {
    const store = memoryCursor(new Date('2026-10-19T12:00:00.000Z'));
    replyJson(
      registryPool,
      mcpServersUrl('https://registry.modelcontextprotocol.io/v0.1', {
        updatedSince: store.value,
        cursor: null,
        includeDeleted: true,
      }),
      { servers: REGISTRY, metadata: { count: 4, nextCursor: 'more' } },
    );

    const refs = await collect(
      adapter({ cursorStore: store }).discover(context(), { maxItems: 1, strategy: 'registry' }),
    );
    expect(refs).toHaveLength(1);
    expect(store.sets).toEqual([]);
    expect(store.value?.toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });
});

describe('MCP fallback discovery (spec §7.3.6)', () => {
  it('combines GitHub topics and npm keywords, applies admission filters and skips linked targets', async () => {
    const store = memoryCursor();
    const filteredTargets: { source: string; externalId: string }[] = [];
    const ctx = context({
      filterLinkedAliasTargets: (targets) => {
        filteredTargets.push(...targets);
        return Promise.resolve(new Set(['github:n8n-io/n8n', 'npm:yahoo-finance2']));
      },
    });

    for (const query of ['topic:mcp-server', 'topic:mcp stars:>=5']) {
      replyJson(githubPool, mcpGitHubSearchUrl(query, 1), {
        total_count: GITHUB.length,
        incomplete_results: false,
        items: GITHUB,
      });
    }
    for (const keyword of ['mcp-server', 'mcp']) {
      replyJson(npmPool, mcpNpmSearchUrl(keyword, 0), { objects: NPM });
    }

    const refs = await collect(
      adapter({
        cursorStore: store,
        github: { tokens: ['test-token'], searchBucket: fakeBucket() },
      }).discover(ctx, {
        maxItems: 20,
        strategy: 'github-npm',
      }),
    );

    expect(refs.map((ref) => ref.externalId)).toEqual([
      'github:google-gemini/gemini-cli',
      'npm:agentic-flow',
      'npm:agent-device',
    ]);
    expect(filteredTargets).toEqual(
      expect.arrayContaining([
        { source: 'github', externalId: 'n8n-io/n8n' },
        { source: 'npm', externalId: 'yahoo-finance2' },
      ]),
    );
    expect(refs[0]?.hint).toMatchObject({ reason: 'github-topic' });
    expect(refs[1]?.hint).toMatchObject({ reason: 'npm-keyword' });
  });

  it('still runs npm discovery when no GitHub token is configured', async () => {
    const store = memoryCursor();
    for (const keyword of ['mcp-server', 'mcp']) {
      replyJson(npmPool, mcpNpmSearchUrl(keyword, 0), { objects: NPM });
    }
    const refs = await collect(
      adapter({ cursorStore: store }).discover(context(), {
        maxItems: 20,
        strategy: 'github-npm',
      }),
    );
    expect(refs.map((ref) => ref.externalId)).toEqual([
      'npm:yahoo-finance2',
      'npm:agentic-flow',
      'npm:agent-device',
    ]);
  });
});

describe('MCP snapshots (spec §7.3.6)', () => {
  it('derives metrics through the injected loader without touching an upstream host', async () => {
    const store = memoryCursor();
    const refs: DiscoveredRef[] = [
      {
        source: 'mcp',
        kind: 'mcp_server',
        externalId: 'ai.example/server',
        itemId: 42n,
      },
    ];
    let seenRefs: readonly DiscoveredRef[] = [];
    const derived = new Map([
      [
        'ai.example/server',
        {
          latest: { stars: 321, downloads: 9 },
          daily: [{ metric: 'downloads' as const, day: '2026-10-20', value: 9 }],
        },
      ],
    ]);
    const ctx = context({
      loadDerivedMetrics: (input) => {
        seenRefs = input;
        return Promise.resolve(derived);
      },
    });

    const fetched = await adapter({ cursorStore: store }).fetchMetrics(ctx, refs, {
      tier: 'hot',
      mode: 'snapshot',
    });
    expect(seenRefs).toEqual(refs);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]?.raw).toEqual({
      kind: 'derived',
      metrics: derived.get('ai.example/server'),
    });

    const first = fetched[0];
    if (first === undefined) throw new Error('expected one fetched MCP item');
    const normalized = adapter({ cursorStore: store }).normalize(first);
    expect(normalized?.item.primaryMetric).toBe('stars');
    expect(normalized?.snapshots).toEqual([{ metric: 'stars', value: 321 }]);
    expect(normalized?.daily).toEqual([{ metric: 'downloads', day: '2026-10-20', value: 9 }]);
  });

  it('maps backfill to the loader daily history', async () => {
    const store = memoryCursor();
    const daily = [{ metric: 'downloads' as const, day: '2026-09-01', value: 4 }];
    let requestedDays: number | undefined;
    const ctx = context({
      loadDerivedMetrics: (_refs, options) => {
        requestedDays = options?.days;
        return Promise.resolve(new Map([['npm:example-mcp', { latest: { downloads: 4 }, daily }]]));
      },
    });
    const result = await adapter({ cursorStore: store }).backfill?.(
      ctx,
      { source: 'mcp', kind: 'mcp_server', externalId: 'npm:example-mcp' },
      60,
    );
    expect(result).toEqual(daily);
    expect(requestedDays).toBe(60);
  });
});

describe('MCP raw fixture sanity', () => {
  it('keeps the recorded payload typed as McpRaw', () => {
    const raw = { kind: 'registry', entry: REGISTRY[0] } as McpRaw;
    expect(raw.kind).toBe('registry');
  });
});
