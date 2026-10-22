import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { ApiClient } from '../src/api-client.js';
import { createTrendrMcpServer } from '../src/server.js';

const unexpected = (): Promise<never> => Promise.reject(new Error('Unexpected API call'));

/** All methods reject unless a test overrides the ones it needs. */
export function mockApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    trending: unexpected,
    search: unexpected,
    getItem: unexpected,
    getHistory: unexpected,
    compare: unexpected,
    getNewItems: unexpected,
    getAliases: unexpected,
    resolveItemId: unexpected,
    ...overrides,
  };
}

export interface McpTestClient {
  client: Client;
  close(): Promise<void>;
}

export async function connectInMemory(api: ApiClient): Promise<McpTestClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createTrendrMcpServer(api);
  await server.connect(serverTransport);
  const client = new Client({ name: 'trendr-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    async close(): Promise<void> {
      await client.close();
      await server.close();
    },
  };
}

export async function withClient<T>(
  api: ApiClient,
  run: (client: Client) => Promise<T>,
): Promise<T> {
  const fixture = await connectInMemory(api);
  try {
    return await run(fixture.client);
  } finally {
    await fixture.close();
  }
}

export function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    return '';
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return '';
  }
  for (const raw of content as unknown[]) {
    if (
      typeof raw === 'object' &&
      raw !== null &&
      'type' in raw &&
      raw.type === 'text' &&
      'text' in raw &&
      typeof raw.text === 'string'
    ) {
      return raw.text;
    }
  }
  return '';
}
