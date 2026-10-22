import { describe, expect, it } from 'vitest';

import { ApiError, HttpApiClient } from '../src/api-client.js';
import type { TrendingApiResponse } from '../src/schemas.js';

const TRENDING: TrendingApiResponse = {
  scope: 'github',
  window: '7d',
  runId: '1',
  computedAt: '2026-10-22T00:00:00.000Z',
  data: [],
  page: { nextCursor: null, limit: 5 },
};

interface RecordedCall {
  input: RequestInfo | URL;
  init: RequestInit | undefined;
}

function inputUrl(input: RequestInfo | URL | undefined): string {
  if (input instanceof URL) {
    return input.toString();
  }
  if (typeof input === 'string') {
    return input;
  }
  return input?.url ?? '';
}

function clientWith(response: () => Response | Promise<Response>): {
  client: HttpApiClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return Promise.resolve(response());
  };
  return {
    calls,
    client: new HttpApiClient({
      baseUrl: 'http://api:4000/',
      apiKey: 'dt_live_secret',
      fetchImpl,
    }),
  };
}

describe('HttpApiClient', () => {
  it('builds trending queries and forwards the API key', async () => {
    const { client, calls } = clientWith(
      () => new Response(JSON.stringify(TRENDING), { status: 200 }),
    );
    const result = await client.trending({ source: 'github', window: '7d', limit: 5 });
    expect(result.window).toBe('7d');
    expect(inputUrl(calls[0]?.input)).toBe(
      'http://api:4000/v1/trending?scope=github&window=7d&limit=5',
    );
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBe('dt_live_secret');
  });

  it('omits the API key header for anonymous clients', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ input, init });
      return Promise.resolve(new Response(JSON.stringify(TRENDING), { status: 200 }));
    };
    const client = new HttpApiClient({
      baseUrl: 'http://localhost:4000',
      fetchImpl,
    });
    await client.trending({ source: 'all', window: '24h', limit: 1 });
    expect(new Headers(calls[0]?.init?.headers).get('x-api-key')).toBeNull();
  });

  it('maps RFC 7807 responses to ApiError', async () => {
    const { client } = clientWith(
      () =>
        new Response(
          JSON.stringify({
            type: 'https://trendr.dev/problems/rate-limited',
            title: 'Rate limited',
            status: 429,
            detail: 'Slow down',
            instance: '/v1/trending',
            requestId: 'req-1',
          }),
          { status: 429 },
        ),
    );
    const error = await client
      .trending({ source: 'all', window: '24h', limit: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 429 });
    expect(error instanceof Error ? error.message : '').toContain('Slow down');
  });

  it('resolves an item id from the 302 lookup redirect', async () => {
    const { client, calls } = clientWith(
      () => new Response(null, { status: 302, headers: { location: '/v1/items/42' } }),
    );
    await expect(client.resolveItemId('github', 'owner/repo')).resolves.toBe('42');
    expect(inputUrl(calls[0]?.input)).toContain(
      '/v1/items/lookup?source=github&externalId=owner%2Frepo',
    );
    expect(calls[0]?.init?.redirect).toBe('manual');
  });

  it('rejects an unexpected lookup redirect', async () => {
    const { client } = clientWith(
      () => new Response(null, { status: 302, headers: { location: '/elsewhere' } }),
    );
    await expect(client.resolveItemId('github', 'owner/repo')).rejects.toBeInstanceOf(ApiError);
  });

  it('rejects API responses that fail the wire schema', async () => {
    const { client } = clientWith(() => new Response(JSON.stringify({}), { status: 200 }));
    await expect(client.trending({ source: 'all', window: '24h', limit: 1 })).rejects.toThrow(
      'invalid response',
    );
  });
});
