import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';

import { NotFoundError } from '@trendr/core';

import { buildApp } from './app.js';

interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance: string;
  requestId: string;
}

const TEST_DEPS = {
  corsOrigins: ['http://localhost:3000'],
  metricsToken: 'test-metrics-token',
  // Production always sets JWT_SECRET, so the global bearer-verifying hook is
  // active; without it `/metrics` vs. the JWT hook would never be exercised.
  jwtSecret: 'test-jwt-secret-for-app-tests-only',
};
/** First build compiles the whole OpenAPI graph; give each test room under load. */
const TEST_TIMEOUT = 15_000;

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp(TEST_DEPS);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('apps/api', () => {
  it(
    'GET /healthz reports liveness',
    async () => {
      await withApp(async (app) => {
        const response = await app.inject({ method: 'GET', url: '/healthz' });
        expect(response.statusCode).toBe(200);
        const body = response.json<{ status: string; uptimeSec: number }>();
        expect(body.status).toBe('ok');
        expect(typeof body.uptimeSec).toBe('number');
        expect(response.headers['x-frame-options']).toBe('DENY');
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'GET /readyz reports degraded when dependencies are absent',
    async () => {
      await withApp(async (app) => {
        const response = await app.inject({ method: 'GET', url: '/readyz' });
        expect(response.statusCode).toBe(503);
        const body = response.json<{ status: string; checks: Record<string, string> }>();
        expect(body.status).toBe('degraded');
        expect(body.checks).toEqual({ db: 'error', redis: 'error', migrations: 'error' });
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'GET /readyz reports ready when all probes succeed',
    async () => {
      await withApp(async (app) => {
        app.decorate('pool', {
          query: () => Promise.resolve({ rowCount: 1, rows: [{}] }),
        } as never);
        app.decorate('redis', { ping: () => Promise.resolve('PONG') } as never);

        const response = await app.inject({ method: 'GET', url: '/readyz' });
        expect(response.statusCode).toBe(200);
        const body = response.json<{ status: string; checks: Record<string, string> }>();
        expect(body.status).toBe('ready');
        expect(body.checks).toEqual({ db: 'ok', redis: 'ok', migrations: 'ok' });
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'answers CORS preflight for configured origins',
    async () => {
      await withApp(async (app) => {
        const response = await app.inject({
          method: 'OPTIONS',
          url: '/healthz',
          headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
        });
        expect(response.statusCode).toBe(204);
        expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'returns a problem+json 404 for unknown routes',
    async () => {
      await withApp(async (app) => {
        const response = await app.inject({ method: 'GET', url: '/nope' });
        expect(response.statusCode).toBe(404);
        expect(response.headers['content-type']).toContain('application/problem+json');
        const problem = response.json<ProblemBody>();
        expect(problem).toMatchObject({
          type: 'https://trendr.dev/problems/not-found',
          title: 'Not Found',
          status: 404,
          instance: '/nope',
        });
        expect(problem.requestId).toEqual(expect.any(String));
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'maps thrown AppErrors to problem+json',
    async () => {
      await withApp(async (app) => {
        app.get('/boom', () => {
          throw new NotFoundError('widget gone');
        });
        const response = await app.inject({ method: 'GET', url: '/boom' });
        expect(response.statusCode).toBe(404);
        expect(response.headers['content-type']).toContain('application/problem+json');
        expect(response.json<ProblemBody>()).toMatchObject({
          type: 'https://trendr.dev/problems/not-found',
          detail: 'widget gone',
        });
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'protects /metrics with the bearer token',
    async () => {
      await withApp(async (app) => {
        const denied = await app.inject({ method: 'GET', url: '/metrics' });
        expect(denied.statusCode).toBe(401);
        expect(denied.headers['content-type']).toContain('application/problem+json');

        // A bearer that is not the metrics token must still be refused (the
        // route-level guard, not the JWT hook, owns this endpoint).
        const wrong = await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer not-the-metrics-token' },
        });
        expect(wrong.statusCode).toBe(401);

        const allowed = await app.inject({
          method: 'GET',
          url: '/metrics',
          headers: { authorization: 'Bearer test-metrics-token' },
        });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.body).toContain('trendr_http_requests_total');
        expect(allowed.body).toContain('trendr_cache_requests_total');
        expect(allowed.body).toContain('trendr_sse_clients');
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'sets a deny-all CSP and echoes the correlation id (spec §15/§14.3)',
    async () => {
      await withApp(async (app) => {
        const response = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-request-id': 'corr-123' },
        });
        expect(response.headers['x-request-id']).toBe('corr-123');
        expect(response.headers['content-security-policy']).toContain("default-src 'none'");
        expect(response.headers['x-content-type-options']).toBe('nosniff');
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects cookie-authenticated writes without the CSRF header',
    async () => {
      await withApp(async (app) => {
        const denied = await app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          headers: { cookie: 'dt_refresh=opaque' },
        });
        expect(denied.statusCode).toBe(403);

        const allowed = await app.inject({
          method: 'POST',
          url: '/v1/auth/refresh',
          headers: { cookie: 'dt_refresh=opaque', 'x-requested-with': 'trendr' },
        });
        expect(allowed.statusCode).not.toBe(403);
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'allows wildcard CORS for public data but not private routes',
    async () => {
      await withApp(async (app) => {
        const publicResponse = await app.inject({
          method: 'GET',
          url: '/v1/topics',
          headers: { origin: 'https://example.com' },
        });
        expect(publicResponse.headers['access-control-allow-origin']).toBe('*');
        expect(publicResponse.headers['access-control-allow-credentials']).toBeUndefined();

        const privateResponse = await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { origin: 'https://example.com' },
        });
        expect(privateResponse.headers['access-control-allow-origin']).toBeUndefined();
      });
    },
    TEST_TIMEOUT,
  );

  it(
    'rejects request bodies above 64 kB',
    async () => {
      await withApp(async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/auth/magic-link',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ email: 'a@example.com', filler: 'x'.repeat(70_000) }),
        });
        expect(response.statusCode).toBe(413);
      });
    },
    TEST_TIMEOUT,
  );
});
