import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import type { Connection } from '@trendr/db';

import { registerCache } from './plugins/cache.js';
import { registerDb } from './plugins/db.js';
import { registerErrors } from './plugins/errors.js';
import { registerEtag } from './plugins/etag.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerOpenApi } from './plugins/openapi.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerRedis } from './plugins/redis.js';
import { registerSecurity } from './plugins/security.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerTrendingRoutes } from './routes/trending.js';

export interface BuildAppDeps {
  /** Pre-built pino logger from main.ts; tests omit it for a silent app. */
  loggerInstance?: FastifyBaseLogger;
  trustProxy?: boolean;
  /** CORS allowlist (env: CORS_ORIGINS). */
  corsOrigins?: string[];
  /** Bearer token guarding /metrics (env: METRICS_TOKEN). */
  metricsToken?: string;
  /** Postgres connection, caller-owned (main.ts from env; tests from Testcontainers). */
  db?: Connection;
  /** Redis client, caller-owned. Without it the cache and the Redis rate-limit store stay off. */
  redis?: Redis;
  /** Dedicated subscriber (SSE, task 3.6); defaults to a duplicate of `redis`. */
  redisSub?: Redis;
  /** Anonymous rate-limit tier (spec §10.5); `false` disables limiting for tooling. */
  rateLimit?: { max?: number; timeWindowMs?: number } | false;
  /** OpenAPI document metadata (spec §10.1). */
  openapi?: { title?: string; version?: string; serverUrl?: string };
}

/**
 * Composition root (spec §4): registers plugins and routes. `main.ts` wires
 * env + logger + connections and listens; tests call this and `app.inject`.
 * Async because hook-adding plugins (security, rate limit, OpenAPI) must be
 * awaited before routes so their hooks cover every route.
 */
export async function buildApp(deps: BuildAppDeps = {}): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: deps.trustProxy ?? false,
    ...(deps.loggerInstance ? { loggerInstance: deps.loggerInstance } : {}),
  });

  await registerSecurity(app, deps);
  registerErrors(app);

  if (deps.db) {
    await app.register(registerDb, { connection: deps.db });
  }
  if (deps.redis) {
    await app.register(registerRedis, {
      redis: deps.redis,
      ...(deps.redisSub ? { redisSub: deps.redisSub } : {}),
    });
    await app.register(registerCache);
  }
  if (deps.rateLimit !== false) {
    await registerRateLimit(app, {
      trustProxy: deps.trustProxy ?? false,
      ...deps.rateLimit,
      ...(deps.redis ? { redis: deps.redis } : {}),
    });
  }
  registerEtag(app);
  await registerOpenApi(app, deps.openapi ?? {});

  // After the OpenAPI plugin so `/metrics` is collected into the document.
  registerMetrics(app, deps);
  registerHealthRoutes(app);
  registerTrendingRoutes(app);

  return app;
}
