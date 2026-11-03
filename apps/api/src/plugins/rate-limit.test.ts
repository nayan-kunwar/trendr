import type { FastifyInstance, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import type { AuthenticatedApiKey } from './api-key.js';
import type { AuthenticatedUser } from './auth.js';
import {
  ADMIN_MAX,
  USER_MAX,
  clientIp,
  observeRateLimitRedis,
  rateLimitKey,
  resolveRateLimitMax,
} from './rate-limit.js';

function fakeRequest(
  headers: Record<string, string>,
  ip: string,
  apiKey?: AuthenticatedApiKey,
  authUser?: AuthenticatedUser,
): FastifyRequest {
  return { headers, ip, apiKey, authUser } as unknown as FastifyRequest;
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

describe('rate-limit store observability (L-11)', () => {
  it('reports store failures and keeps the plugin callback contract', async () => {
    const failures: unknown[] = [];
    const seen: (Error | null)[] = [];
    const client = {
      calls: 0,
      rateLimit(
        _key: string,
        _ttl: number,
        _max: number,
        _a: boolean,
        _b: boolean,
        cb: (error: Error | null, result: unknown) => void,
      ) {
        this.calls += 1;
        cb(new Error('redis down'), null);
      },
      other(): string {
        return 'forwarded';
      },
    };

    const observed = observeRateLimitRedis(client, (error) => failures.push(error));
    await new Promise<void>((resolve) => {
      observed.rateLimit('k', 60_000, 60, false, false, (error) => {
        seen.push(error);
        resolve();
      });
    });

    expect(client.calls).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBeInstanceOf(Error);
    expect(seen[0]).toBeInstanceOf(Error);
    // Non-limiter members keep working and keep their `this` binding.
    expect(observed.other()).toBe('forwarded');
  });

  it('does not report successful store calls', async () => {
    const failures: unknown[] = [];
    const client = {
      rateLimit(
        _key: string,
        _ttl: number,
        _max: number,
        _a: boolean,
        _b: boolean,
        cb: (error: Error | null, result: unknown) => void,
      ) {
        cb(null, [1, 60_000]);
      },
    };
    const observed = observeRateLimitRedis(client, (error) => {
      failures.push(error);
    });
    await new Promise<void>((resolve) => {
      observed.rateLimit('k', 60_000, 60, false, false, () => {
        resolve();
      });
    });
    expect(failures).toHaveLength(0);
  });

  it('exposes the degraded counter when the limiter is enabled', async () => {
    await withApp(DEPS, async (app) => {
      expect(app.hasDecorator('observeRateLimitDegraded')).toBe(true);
      app.observeRateLimitDegraded();
      const response = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: `Bearer ${DEPS.metricsToken}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('trendr_rate_limit_degraded_total 1');
    });
  });
});

describe('clientIp (spec §10.5)', () => {
  it('prefers CF-Connecting-IP only behind a trusted proxy', () => {
    const request = fakeRequest({ 'cf-connecting-ip': '203.0.113.9' }, '10.0.0.1');
    expect(clientIp(request, true)).toBe('203.0.113.9');
    expect(clientIp(request, false)).toBe('10.0.0.1');
  });

  it('falls back to the socket peer without the header', () => {
    expect(clientIp(fakeRequest({}, '10.0.0.2'), true)).toBe('10.0.0.2');
  });

  it('accepts IPv4 and IPv6 header values', () => {
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '203.0.113.9' }, '10.0.0.1'), true)).toBe(
      '203.0.113.9',
    );
    expect(clientIp(fakeRequest({ 'cf-connecting-ip': '2001:db8::1' }, '10.0.0.1'), true)).toBe(
      '2001:db8::1',
    );
  });

  it('ignores a header that is not a bare IP address', () => {
    // H-1: an untrusted value must never become a rate-limit key or an
    // `auth_tokens.created_ip` inet write.
    for (const forged of [
      'attacker',
      '203.0.113.9, 10.0.0.1',
      '203.0.113.9:443',
      '999.1.1.1',
      '',
      ' ',
    ]) {
      expect(clientIp(fakeRequest({ 'cf-connecting-ip': forged }, '10.0.0.1'), true)).toBe(
        '10.0.0.1',
      );
    }
  });
});

describe('per-tier limits and keys (spec §10.5)', () => {
  const apiKey: AuthenticatedApiKey = {
    id: 'a7f0c0de-0000-0000-0000-000000000000',
    userId: '0b9c1f76-0000-0000-0000-000000000000',
    scopes: ['read'],
    rateLimitPerMin: 77,
  };

  it('keys authenticated requests by API key id, anonymous ones by IP', () => {
    expect(rateLimitKey(fakeRequest({}, '10.0.0.1', apiKey), false)).toBe(`key:${apiKey.id}`);
    expect(rateLimitKey(fakeRequest({}, '10.0.0.1'), false)).toBe('ip:10.0.0.1');
    expect(rateLimitKey(fakeRequest({ 'cf-connecting-ip': '203.0.113.9' }, '10.0.0.1'), true)).toBe(
      'ip:203.0.113.9',
    );
  });

  it('uses the per-key budget for authenticated requests only', () => {
    expect(resolveRateLimitMax(fakeRequest({}, '10.0.0.1', apiKey), 60)).toBe(77);
    expect(resolveRateLimitMax(fakeRequest({}, '10.0.0.1'), 60)).toBe(60);
  });

  it('keys JWT requests by user id and applies the 300/600 tiers (§10.5)', () => {
    const user: AuthenticatedUser = { id: '0b9c1f76-1111-1111-1111-111111111111', role: 'user' };
    const admin: AuthenticatedUser = { id: '0b9c1f76-2222-2222-2222-222222222222', role: 'admin' };

    expect(rateLimitKey(fakeRequest({}, '10.0.0.1', undefined, user), false)).toBe(
      `user:${user.id}`,
    );
    expect(resolveRateLimitMax(fakeRequest({}, '10.0.0.1', undefined, user), 60)).toBe(USER_MAX);
    expect(resolveRateLimitMax(fakeRequest({}, '10.0.0.1', undefined, admin), 60)).toBe(ADMIN_MAX);
    // An API key identity wins over a bearer token (spec key order).
    expect(rateLimitKey(fakeRequest({}, '10.0.0.1', apiKey, admin), false)).toBe(
      `key:${apiKey.id}`,
    );
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

  it('does not let a forged CF-Connecting-IP escape the anonymous bucket', async () => {
    await withApp(
      { ...DEPS, trustProxy: true, rateLimit: { max: 1, timeWindowMs: 60_000 } },
      async (app) => {
        const request = (forged: string) =>
          app.inject({
            method: 'GET',
            url: '/healthz',
            remoteAddress: '198.51.100.7',
            headers: { 'cf-connecting-ip': forged },
          });

        expect((await request('not-an-ip')).statusCode).toBe(200);
        expect((await request('also-not-an-ip')).statusCode).toBe(429);
        expect((await request('203.0.113.99:443')).statusCode).toBe(429);
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
