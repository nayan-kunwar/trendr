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
};

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = buildApp(TEST_DEPS);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('apps/api', () => {
  it('GET /healthz reports liveness', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/healthz' });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; uptimeSec: number }>();
      expect(body.status).toBe('ok');
      expect(typeof body.uptimeSec).toBe('number');
      expect(response.headers['x-frame-options']).toBe('DENY');
    });
  });

  it('GET /readyz reports readiness with check details', async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ status: string; checks: Record<string, string> }>();
      expect(body.status).toBe('ready');
      expect(body.checks).toMatchObject({ db: 'ok', redis: 'ok', migrations: 'ok' });
    });
  });

  it('answers CORS preflight for configured origins', async () => {
    await withApp(async (app) => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/healthz',
        headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'GET' },
      });
      expect(response.statusCode).toBe(204);
      expect(response.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    });
  });

  it('returns a problem+json 404 for unknown routes', async () => {
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
  });

  it('maps thrown AppErrors to problem+json', async () => {
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
  });

  it('protects /metrics with the bearer token', async () => {
    await withApp(async (app) => {
      const denied = await app.inject({ method: 'GET', url: '/metrics' });
      expect(denied.statusCode).toBe(401);
      expect(denied.headers['content-type']).toContain('application/problem+json');

      const allowed = await app.inject({
        method: 'GET',
        url: '/metrics',
        headers: { authorization: 'Bearer test-metrics-token' },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).toContain('trendr_http_requests_total');
    });
  });
});
