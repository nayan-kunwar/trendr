import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { clientIp } from './rate-limit.js';

function fakeRequest(headers: Record<string, string>, ip: string): FastifyRequest {
  return { headers, ip } as unknown as FastifyRequest;
}

const DEPS = { corsOrigins: ['http://localhost:3000'], metricsToken: 'test-metrics-token' };

async function withApp(
  deps: Parameters<typeof buildApp>[0],
  run: (app: FastifyInstance) => Promise<void>,
): Promise<void> {
  const app = await buildApp(deps);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('clientIp (spec §10.5)', () => {
  it('prefers CF-Connecting-IP only behind a trusted proxy', () => {
    const request = fakeRequest({ 'cf-connecting-ip': '203.0.113.9' }, '10.0.0.1');
    expect(clientIp(request, true)).toBe('203.0.113.9');
    expect(clientIp(request, false)).toBe('10.0.0.1');
  });

  it('falls back to the socket peer without the header', () => {
    expect(clientIp(fakeRequest({}, '10.0.0.2'), true)).toBe('10.0.0.2');
  });
});

describe('rate limit plugin (spec §10.5)', () => {
  it('answers 429 with problem+json and draft rate-limit headers past the limit', async () => {
    await withApp({ ...DEPS, rateLimit: { max: 2, timeWindowMs: 60_000 } }, async (app) => {
      const first = await app.inject({ method: 'GET', url: '/healthz' });
      expect(first.statusCode).toBe(200);
      expect(first.headers['ratelimit-limit']).toBe('2');
      expect(first.headers['ratelimit-remaining']).toBe('1');

      const second = await app.inject({ method: 'GET', url: '/healthz' });
      expect(second.statusCode).toBe(200);

      const third = await app.inject({ method: 'GET', url: '/healthz' });
      expect(third.statusCode).toBe(429);
      expect(third.headers['content-type']).toContain('application/problem+json');
      expect(third.headers['retry-after']).toBeDefined();
      expect(third.headers['ratelimit-limit']).toBe('2');
      expect(third.headers['ratelimit-remaining']).toBe('0');
      expect(third.json<{ type: string }>().type).toBe('https://trendr.dev/problems/rate-limited');
    });
  });

  it('keys trusted CF-Connecting-IP clients separately', async () => {
    await withApp(
      { ...DEPS, trustProxy: true, rateLimit: { max: 1, timeWindowMs: 60_000 } },
      async (app) => {
        const clientA = { 'cf-connecting-ip': '203.0.113.1' };
        const clientB = { 'cf-connecting-ip': '203.0.113.2' };

        const a1 = await app.inject({ method: 'GET', url: '/healthz', headers: clientA });
        expect(a1.statusCode).toBe(200);

        const a2 = await app.inject({ method: 'GET', url: '/healthz', headers: clientA });
        expect(a2.statusCode).toBe(429);

        const b1 = await app.inject({ method: 'GET', url: '/healthz', headers: clientB });
        expect(b1.statusCode).toBe(200);
      },
    );
  });

  it('can be disabled for tooling (openapi export)', async () => {
    await withApp({ ...DEPS, rateLimit: false }, async (app) => {
      for (let i = 0; i < 5; i += 1) {
        const response = await app.inject({ method: 'GET', url: '/healthz' });
        expect(response.statusCode).toBe(200);
      }
      expect(
        (await app.inject({ method: 'GET', url: '/healthz' })).headers['ratelimit-limit'],
      ).toBe(undefined);
    });
  });
});
