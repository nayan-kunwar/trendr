import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { FastifyInstance } from 'fastify';

import { timingSafeStringEqual, UnauthorizedError } from '@trendr/core';
import type { Connection } from '@trendr/db';

import type { CacheKind, CacheResult } from './cache.js';

export interface MetricsOptions {
  /** Bearer token required by GET /metrics (env: METRICS_TOKEN). */
  metricsToken?: string;
  /** Pool exposed by `trendr_db_pool_connections` (spec §14.1). */
  db?: Connection;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Gauge `trendr_sse_clients{scope,window}` (spec §10.6). */
    sseClients: Gauge;
    /** Counter `trendr_cache_requests_total{cache,result}` (spec §14.1). */
    observeCache: (cache: CacheKind, result: CacheResult) => void;
  }
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
  // Spec §10.6 — open SSE streams per board, updated by the stream route.
  const sseClients = new Gauge({
    name: 'trendr_sse_clients',
    help: 'Open leaderboard SSE streams by board.',
    labelNames: ['scope', 'window'],
    registers: [registry],
  });
  app.decorate('sseClients', sseClients);

  // Spec §14.1 — cache hit/miss counter shared by read-through and leaderboard.
  const cacheRequests = new Counter({
    name: 'trendr_cache_requests_total',
    help: 'Cache lookups by cache namespace and result.',
    labelNames: ['cache', 'result'],
    registers: [registry],
  });
  app.decorate('observeCache', (cache: CacheKind, result: CacheResult) => {
    cacheRequests.inc({ cache, result });
  });

  // Spec §14.1 — scrape-time pool counters; no series when the API has no DB.
  if (options.db !== undefined) {
    const pool = options.db.pool;
    new Gauge({
      name: 'trendr_db_pool_connections',
      help: 'Postgres pool connections by state.',
      labelNames: ['state'],
      registers: [registry],
      collect() {
        this.set({ state: 'total' }, pool.totalCount);
        this.set({ state: 'idle' }, pool.idleCount);
        this.set({ state: 'waiting' }, pool.waitingCount);
      },
    });
  }

  app.addHook('onResponse', (request, reply, done) => {
    const rawUrl: unknown = request.routeOptions.url;
    const route = typeof rawUrl === 'string' && rawUrl !== '' ? rawUrl : 'unmatched';
    httpRequestsTotal.inc({ method: request.method, route, status: String(reply.statusCode) });
    httpRequestDuration.observe({ method: request.method, route }, reply.elapsedTime / 1000);
    done();
  });

  app.get('/metrics', (request, reply) => {
    const authorization = request.headers.authorization;
    if (
      options.metricsToken === undefined ||
      authorization === undefined ||
      !timingSafeStringEqual(authorization, `Bearer ${options.metricsToken}`)
    ) {
      throw new UnauthorizedError('metrics requires a bearer token');
    }
    reply.type(registry.contentType);
    return registry.metrics();
  });
}
