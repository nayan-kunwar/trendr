import { describe, expect, it, vi } from 'vitest';

import {
  CompareOutputSchema,
  HistoryOutputSchema,
  SearchOutputSchema,
  TrendingOutputSchema,
  WhatsNewOutputSchema,
  type AliasesApiResponse,
  type CompareApiResponse,
  type HistoryApiResponse,
  type ItemDetailApi,
  type NewApiResponse,
  type SearchApiResponse,
  type TrendingApiResponse,
} from '../src/schemas.js';
import { mockApi, textOf, withClient } from './helpers.js';

const TRENDING: TrendingApiResponse = {
  scope: 'github',
  window: '7d',
  runId: '1',
  computedAt: '2026-10-22T00:00:00.000Z',
  data: [
    {
      rank: 1,
      item: {
        id: '1',
        source: 'github',
        kind: 'repo',
        externalId: 'owner/repo',
        displayName: 'owner/repo',
        description: 'A useful repository',
        url: 'https://github.com/owner/repo',
        language: 'TypeScript',
        topics: ['ai'],
        primaryMetric: 'stars',
      },
      window: '7d',
      delta: 120,
      relGrowth: 0.25,
      score: 8.5,
      percentile: 99,
      current: 12_000,
      sparkline: [1, 2],
      flags: ['new_item'],
    },
  ],
  page: { nextCursor: null, limit: 5 },
};

const SEARCH: SearchApiResponse = {
  items: [
    {
      id: '2',
      source: 'npm',
      kind: 'package',
      name: 'agenttrust',
      url: 'https://www.npmjs.com/package/agenttrust',
      description: 'Trust checks for agents',
      current: 5_000,
      score7d: 3.2,
      upstreamCreatedAt: '2026-10-01T00:00:00.000Z',
    },
  ],
  page: { nextCursor: null, limit: 10 },
};

const ITEM: ItemDetailApi = {
  id: '1',
  source: 'github',
  kind: 'repo',
  name: 'repo',
  displayName: 'owner/repo',
  description: 'A useful repository',
  url: 'https://github.com/owner/repo',
  primaryMetric: 'stars',
  latestMetrics: { stars: 120 },
  scores: {
    '24h': null,
    '7d': { finalScore: 4.5, percentile: 91 },
    '30d': null,
  },
  upstreamCreatedAt: null,
};

const HISTORY: HistoryApiResponse = {
  itemId: '1',
  metric: 'stars',
  kind: 'cumulative',
  granularity: 'day',
  points: [
    { t: '2026-10-18', v: 100 },
    { t: '2026-10-19', v: 105 },
    { t: '2026-10-20', v: 103 },
    { t: '2026-10-21', v: 120 },
  ],
};

const ALIASES: AliasesApiResponse = {
  itemId: '9',
  aliases: [
    {
      id: '10',
      source: 'github',
      kind: 'repo',
      externalId: 'owner/server',
      displayName: 'owner/server',
      url: 'https://github.com/owner/server',
      relation: 'mcp_server_of',
      confidence: 1,
      evidence: 'registry metadata',
      direction: 'outgoing',
    },
    {
      id: '11',
      source: 'npm',
      kind: 'package',
      externalId: '@scope/server',
      displayName: '@scope/server',
      url: 'https://www.npmjs.com/package/@scope/server',
      relation: 'mcp_server_of',
      confidence: 1,
      evidence: 'registry metadata',
      direction: 'outgoing',
    },
  ],
};

const REGISTRY_URL =
  'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.owner%2Fserver/versions/latest';

const NEW_MCP: NewApiResponse = {
  items: [
    {
      id: '9',
      source: 'mcp',
      kind: 'mcp_server',
      name: 'server',
      url: REGISTRY_URL,
      description: 'An MCP server',
      current: 42,
      score7d: null,
      upstreamCreatedAt: '2026-10-20T12:00:00.000Z',
    },
  ],
  page: { nextCursor: null, limit: 50 },
};

const COMPARE: CompareApiResponse = {
  window: '30d',
  granularity: 'day',
  metric: null,
  items: [
    {
      id: '1',
      source: 'github',
      kind: 'repo',
      name: 'repo',
      displayName: 'owner/repo',
      url: 'https://github.com/owner/repo',
      delta: 120,
      relGrowth: 0.25,
      percentile: 99,
      rankSource: 1,
    },
    {
      id: '2',
      source: 'npm',
      kind: 'package',
      name: 'agenttrust',
      displayName: 'agenttrust',
      url: 'https://www.npmjs.com/package/agenttrust',
      delta: null,
      relGrowth: null,
      percentile: null,
      rankSource: null,
    },
  ],
  series: {
    '1': [{ t: '2026-10-01', v: 10 }],
    '2': [{ t: '2026-10-01', v: 20 }],
  },
};

describe('MCP tools', () => {
  it('lists the five read-only tools with input and output schemas', async () => {
    await withClient(mockApi(), async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        'compare_items',
        'get_item_history',
        'get_trending',
        'search_items',
        'whats_new_in_mcp',
      ]);
      for (const tool of tools) {
        expect(tool.description).toBeTruthy();
        expect(tool.inputSchema).toMatchObject({ type: 'object' });
        expect(tool.outputSchema).toMatchObject({ type: 'object' });
        expect(tool.annotations?.readOnlyHint).toBe(true);
      }
      const properties = Object.fromEntries(
        tools.map((tool) => [
          tool.name,
          Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>).sort(),
        ]),
      );
      expect(properties).toEqual({
        compare_items: ['ids', 'metric', 'window'],
        get_item_history: ['days', 'externalId', 'granularity', 'id', 'metric', 'source'],
        get_trending: ['language', 'limit', 'source', 'topic', 'window'],
        search_items: ['kind', 'limit', 'query', 'source'],
        whats_new_in_mcp: ['days', 'limit', 'sort'],
      });
    });
  });

  it('returns structured trending items and Markdown', async () => {
    const trending = vi.fn(() => Promise.resolve(TRENDING));
    await withClient(mockApi({ trending }), async (client) => {
      const result = await client.callTool({
        name: 'get_trending',
        arguments: {
          source: 'github',
          window: '7d',
          language: 'TypeScript',
          topic: 'ai',
          limit: 5,
        },
      });
      expect(result.isError).not.toBe(true);
      const output = TrendingOutputSchema.parse(result.structuredContent);
      expect(output.window).toBe('7d');
      expect(output.items[0]).toMatchObject({
        rank: 1,
        id: '1',
        name: 'owner/repo',
        delta: 120,
      });
      expect(textOf(result)).toContain('owner/repo');
      expect(trending).toHaveBeenCalledWith({
        source: 'github',
        window: '7d',
        limit: 5,
        lang: 'typescript',
        topic: 'ai',
      });
    });
  });

  it('returns search results with the compact item shape', async () => {
    const search = vi.fn(() => Promise.resolve(SEARCH));
    await withClient(mockApi({ search }), async (client) => {
      const result = await client.callTool({
        name: 'search_items',
        arguments: { query: 'agent', source: 'npm', limit: 10 },
      });
      expect(result.isError).not.toBe(true);
      const output = SearchOutputSchema.parse(result.structuredContent);
      expect(output.items[0]).toMatchObject({ id: '2', name: 'agenttrust', score7d: 3.2 });
      expect(textOf(result)).toContain('agenttrust');
      expect(search).toHaveBeenCalledWith({ q: 'agent', source: 'npm', limit: 10 });
    });
  });

  it('combines item detail and history into a growth summary', async () => {
    const getItem = vi.fn(() => Promise.resolve(ITEM));
    const getHistory = vi.fn(() => Promise.resolve(HISTORY));
    await withClient(mockApi({ getItem, getHistory }), async (client) => {
      const result = await client.callTool({
        name: 'get_item_history',
        arguments: { id: '1', metric: 'stars', days: 30 },
      });
      expect(result.isError).not.toBe(true);
      const output = HistoryOutputSchema.parse(result.structuredContent);
      expect(output.item).toMatchObject({
        id: '1',
        name: 'owner/repo',
        current: 120,
        score7d: 4.5,
      });
      expect(output.summary).toEqual({ first: 100, last: 120, delta: 20, maxDailyGain: 17 });
      expect(textOf(result)).toContain('max daily gain');
      expect(getItem).toHaveBeenCalledWith('1');
      expect(getHistory).toHaveBeenCalledWith(
        '1',
        expect.objectContaining({ metric: 'stars', granularity: 'day' }),
      );
    });
  });

  it('resolves source + externalId before loading history', async () => {
    const resolveItemId = vi.fn(() => Promise.resolve('1'));
    const getItem = vi.fn(() => Promise.resolve(ITEM));
    const getHistory = vi.fn(() => Promise.resolve(HISTORY));
    await withClient(mockApi({ resolveItemId, getItem, getHistory }), async (client) => {
      const result = await client.callTool({
        name: 'get_item_history',
        arguments: { source: 'github', externalId: 'owner/repo', days: 7 },
      });
      expect(result.isError).not.toBe(true);
      HistoryOutputSchema.parse(result.structuredContent);
      expect(resolveItemId).toHaveBeenCalledWith('github', 'owner/repo');
    });
  });

  it('compares items and preserves nullable score fields', async () => {
    const compare = vi.fn(() => Promise.resolve(COMPARE));
    await withClient(mockApi({ compare }), async (client) => {
      const result = await client.callTool({
        name: 'compare_items',
        arguments: { ids: ['1', '2'], window: '30d' },
      });
      expect(result.isError).not.toBe(true);
      const output = CompareOutputSchema.parse(result.structuredContent);
      expect(output.items).toHaveLength(2);
      expect(output.items[1]).toMatchObject({ name: 'agenttrust', delta: null });
      expect(output.series['1']).toHaveLength(1);
      expect(textOf(result)).toContain('Compare items');
      expect(compare).toHaveBeenCalledWith({ ids: ['1', '2'], window: '30d' });
    });
  });

  it('merges MCP aliases into new-server links and packages', async () => {
    const getNewItems = vi.fn(() => Promise.resolve(NEW_MCP));
    const getAliases = vi.fn(() => Promise.resolve(ALIASES));
    await withClient(mockApi({ getNewItems, getAliases }), async (client) => {
      const result = await client.callTool({
        name: 'whats_new_in_mcp',
        arguments: { sort: 'new', days: 7, limit: 10 },
      });
      expect(result.isError).not.toBe(true);
      const output = WhatsNewOutputSchema.parse(result.structuredContent);
      expect(output.items[0]).toMatchObject({
        id: '9',
        name: 'server',
        registryName: 'io.github.owner/server',
        repoUrl: 'https://github.com/owner/server',
        publishedAt: '2026-10-20T12:00:00.000Z',
        current: 42,
        packages: [{ registryType: 'npm', identifier: '@scope/server' }],
      });
      expect(textOf(result)).toContain('repo');
      expect(getNewItems).toHaveBeenCalledWith({ source: 'mcp', days: 7 });
    });
  });

  it('defaults whats_new to the rising board with the spec limit', async () => {
    const trending = vi.fn(() => Promise.resolve({ ...TRENDING, scope: 'mcp' as const, data: [] }));
    await withClient(mockApi({ trending }), async (client) => {
      const result = await client.callTool({
        name: 'whats_new_in_mcp',
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      WhatsNewOutputSchema.parse(result.structuredContent);
      expect(trending).toHaveBeenCalledWith({
        source: 'mcp',
        window: '7d',
        kind: 'mcp_server',
        limit: 15,
      });
    });
  });

  it('uses the rising board delta and caps alias lookups at 15', async () => {
    const base = TRENDING.data[0];
    if (!base) {
      throw new Error('Trending fixture must have an item');
    }
    const items = Array.from({ length: 20 }, (_, index) => ({
      ...base,
      rank: index + 1,
      item: {
        ...base.item,
        id: String(index + 1),
        externalId: `owner/server-${index + 1}`,
        displayName: `owner/server-${index + 1}`,
        url: `https://registry.modelcontextprotocol.io/v0.1/servers/owner%2Fserver-${index + 1}/versions/latest`,
        source: 'mcp' as const,
        kind: 'mcp_server' as const,
      },
      delta: index + 1,
    }));
    const trending = vi.fn((): Promise<TrendingApiResponse> =>
      Promise.resolve({
        ...TRENDING,
        scope: 'mcp',
        data: items,
      }),
    );
    const getAliases = vi.fn((): Promise<AliasesApiResponse> =>
      Promise.resolve({ itemId: 'ignored', aliases: [] }),
    );
    await withClient(mockApi({ trending, getAliases }), async (client) => {
      const result = await client.callTool({
        name: 'whats_new_in_mcp',
        arguments: { sort: 'rising', limit: 20 },
      });
      expect(result.isError).not.toBe(true);
      const output = WhatsNewOutputSchema.parse(result.structuredContent);
      expect(output.items).toHaveLength(20);
      expect(output.items[19]?.delta7d).toBe(20);
      expect(output.items[0]?.publishedAt).toBeUndefined();
      expect(getAliases).toHaveBeenCalledTimes(15);
    });
  });
});
