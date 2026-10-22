import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import { createMcpHttpServer, type McpHttpServerHandle } from '../src/http.js';
import { mockApi } from './helpers.js';

async function listen(handle: McpHttpServerHandle): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    handle.server.once('error', reject);
    handle.server.listen(0, '127.0.0.1', () => {
      handle.server.off('error', reject);
      resolve();
    });
  });
  const address = handle.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected an IP address');
  }
  return address.port;
}

describe('Streamable HTTP transport', () => {
  it('lists tools over an authenticated stateless session and protects /mcp', async () => {
    const handle = createMcpHttpServer(mockApi(), { authTokens: ['test-token'] });
    const port = await listen(handle);
    const url = `http://127.0.0.1:${port}/mcp`;
    const client = new Client({ name: 'http-test', version: '1.0.0' });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: 'Bearer test-token' } },
      });
      await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(5);

      const unauthorized = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(unauthorized.status).toBe(401);

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: 'ok' });

      const get = await fetch(url, { method: 'GET' });
      expect(get.status).toBe(405);
    } finally {
      await client.close();
      await handle.close();
    }
  });
});
