import type { FastifyInstance } from 'fastify';

/**
 * Liveness/readiness (spec §14.4). The readiness checks are stubbed here and
 * get real Postgres/Redis/migration probes in Phase 1.
 */
export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/healthz', () => ({ status: 'ok', uptimeSec: process.uptime() }));

  app.get('/readyz', () => ({
    status: 'ready',
    checks: { db: 'ok', redis: 'ok', migrations: 'ok' },
  }));
}
