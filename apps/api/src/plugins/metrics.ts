import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { FastifyInstance } from 'fastify';

import { UnauthorizedError } from '@trendr/core';

export interface MetricsOptions {
  /** Bearer token required by GET /metrics (env: METRICS_TOKEN). */
  metricsToken?: string;
}

/**
 * Prometheus metrics (spec §14.1): `trendr_`-prefixed runtime metrics, the
 * HTTP counter/histogram pair, and a token-guarded GET /metrics.
 */
export function registerMetrics(app: FastifyInstance, options: MetricsOptions = {}): void {
  const registry = new Registry();
  collectDefaultMetrics({ prefix: 'trendr_', register: registry });

  const httpRequestsTotal = new Counter({
    name: 'trendr_http_requests_total',
    help: 'Total HTTP requests by method, route and status.',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  const httpRequestDuration = new Histogram({
    name: 'trendr_http_request_duration_seconds',
    help: 'HTTP request duration in seconds.',
    labelNames: ['method', 'route'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  app.addHook('onResponse', (request, reply, done) => {
    const rawUrl: unknown = request.routeOptions.url;
    const route = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : 'unmatched';
    httpRequestsTotal.inc({ method: request.method, route, status: String(reply.statusCode) });
    httpRequestDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    done();
  });

  app.get('/metrics', (request, reply) => {
    const authorization = request.headers.authorization;
    if (options.metricsToken === undefined || authorization !== `Bearer ${options.metricsToken}`) {
      throw new UnauthorizedError('metrics requires a bearer token');
    }
    reply.type(registry.contentType);
    return registry.metrics();
  });
}
