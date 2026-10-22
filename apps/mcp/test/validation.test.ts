import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';

import { mockApi, textOf, withClient } from './helpers.js';

async function expectToolError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  fragment: string,
): Promise<void> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).toBe(true);
  expect(textOf(result).toLowerCase()).toContain(fragment.toLowerCase());
}

describe('MCP input validation', () => {
  it('rejects invalid get_trending filters', async () => {
    await withClient(mockApi(), async (client) => {
      await expectToolError(client, 'get_trending', { window: '7d', limit: 51 }, 'limit');
      await expectToolError(client, 'get_trending', { source: 'unknown' }, 'source');
    });
  });

  it('rejects invalid search queries and limits', async () => {
    await withClient(mockApi(), async (client) => {
      await expectToolError(client, 'search_items', { query: 'a' }, 'query');
      await expectToolError(client, 'search_items', { query: 'agent', limit: 26 }, 'limit');
    });
  });

  it('requires an item identity and valid history options', async () => {
    await withClient(mockApi(), async (client) => {
      await expectToolError(client, 'get_item_history', {}, 'id');
      await expectToolError(client, 'get_item_history', { source: 'github' }, 'externalId');
      await expectToolError(
        client,
        'get_item_history',
        { id: '1', days: 30, granularity: 'hour' },
        '14 days',
      );
      await expectToolError(
        client,
        'get_item_history',
        { id: '1', metric: 'not-a-metric' },
        'metric',
      );
    });
  });

  it('requires 2–5 unique compare ids', async () => {
    await withClient(mockApi(), async (client) => {
      await expectToolError(client, 'compare_items', { ids: ['1'] }, 'ids');
      await expectToolError(
        client,
        'compare_items',
        { ids: ['1', '2', '3', '4', '5', '6'] },
        'ids',
      );
      await expectToolError(client, 'compare_items', { ids: ['1', '1'] }, 'unique');
    });
  });

  it('rejects invalid whats_new options', async () => {
    await withClient(mockApi(), async (client) => {
      await expectToolError(client, 'whats_new_in_mcp', { days: 31 }, 'days');
      await expectToolError(client, 'whats_new_in_mcp', { limit: 51 }, 'limit');
      await expectToolError(client, 'whats_new_in_mcp', { sort: 'hot' }, 'sort');
    });
  });

  it('surfaces API failures as tool errors', async () => {
    const api = mockApi({
      trending: () => Promise.reject(new Error('upstream exploded')),
    });
    await withClient(api, async (client) => {
      await expectToolError(client, 'get_trending', {}, 'upstream exploded');
    });
  });
});
