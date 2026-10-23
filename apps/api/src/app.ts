import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { Redis } from 'ioredis';

import type { Connection } from '@trendr/db';
import type { EmailSender } from '@trendr/email';

import { registerApiKey } from './plugins/api-key.js';
import { registerAuth } from './plugins/auth.js';
import { registerCache } from './plugins/cache.js';
import { registerCsrf } from './plugins/csrf.js';
import { registerDb } from './plugins/db.js';
import { registerErrors } from './plugins/errors.js';
import { registerEtag } from './plugins/etag.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerOpenApi } from './plugins/openapi.js';
import { registerRateLimit } from './plugins/rate-limit.js';
import { registerRedis } from './plugins/redis.js';
import { registerSecurity } from './plugins/security.js';
import { createApiQueues, type ApiQueues } from './queues.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerApiKeyRoutes } from './routes/api-keys.js';
import { registerAlertRoutes } from './routes/alerts.js';
import { registerAuthRoutes, type AuthRoutesOptions } from './routes/auth.js';
import { registerCompareRoutes } from './routes/compare.js';
import { registerDigestRoutes, registerUnsubscribeRoutes } from './routes/digest.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerItemRoutes } from './routes/items.js';
import { registerNewRoutes } from './routes/new.js';
import { registerSearchRoutes } from './routes/search.js';
import { registerStatsRoutes } from './routes/stats.js';
import { registerStreamRoutes } from './routes/stream.js';
import { registerTopicRoutes } from './routes/topics.js';
import { registerTrendingRoutes } from './routes/trending.js';
import { registerWatchlistRoutes } from './routes/watchlists.js';

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
  /**
   * API_KEY_PEPPER (spec §15). Present + a db connection → `X-API-Key`
   * authentication; absent → keyed requests fall back to the anonymous tier.
   */
  apiKeyPepper?: string;
  /** JWT_SECRET (spec §15). Present → bearer tokens are verified and admin routes enforce §10.5. */
  jwtSecret?: string;
  /** Magic-link/refresh/profile configuration (task 7.1). */
  auth?: Omit<AuthRoutesOptions, 'emailSender'> & { emailSender: EmailSender };
  /**
   * Dedicated BullMQ producer connection (spec §10.1 admin triggers, §7.7 DLQ
   * replay). Caller-owned; the app closes the queues but not the client.
   */
  queueConnection?: Redis;
  /** Anonymous rate-limit tier (spec §10.5); `false` disables limiting for tooling. */
  rateLimit?: { max?: number; timeWindowMs?: number } | false;
  /** UNSUBSCRIBE_SECRET for the §13.4 one-click links; absent in tooling builds. */
  unsubscribeSecret?: string;
  /** Scores-retention bounds for `/v1/items/:id/scores` (env: SCORES_*; §10.4). */
  scoresRetention?: { hourlyHours: number; dailyDays: number };
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
    // Spec §15: reject oversized bodies before validation or handlers run.
    bodyLimit: 64 * 1024,
    // Spec §14.3: accept the caller's correlation id and echo it back.
    requestIdHeader: 'x-request-id',
    ...(deps.loggerInstance ? { loggerInstance: deps.loggerInstance } : {}),
  });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  let queues: ApiQueues | undefined;
  if (deps.queueConnection !== undefined) {
    queues = createApiQueues(deps.queueConnection);
    const apiQueues = queues;
    app.addHook('onClose', async () => {
      await apiQueues.close();
    });
  }

  await registerSecurity(app, deps);
  registerErrors(app);
  await app.register(cookie);
  registerCsrf(app);

  if (deps.db) {
    await app.register(registerDb, { connection: deps.db });
  }
  if (deps.redis) {
    await app.register(registerRedis, {
      redis: deps.redis,
      ...(deps.redisSub ? { redisSub: deps.redisSub } : {}),
    });
    // The metrics plugin registers later; the cache plugin resolves the
    // observer decorator at request time, so no explicit callback is needed.
    await app.register(registerCache);
  }
  if (deps.apiKeyPepper !== undefined && deps.db !== undefined) {
    await app.register(registerApiKey, {
      pepper: deps.apiKeyPepper,
      ...(deps.redis ? { redis: deps.redis } : {}),
    });
  }
  if (deps.jwtSecret !== undefined) {
    await app.register(registerAuth, {
      secret: deps.jwtSecret,
      ...(deps.auth?.accessTokenTtlSeconds === undefined
        ? {}
        : { accessTtlSeconds: deps.auth.accessTokenTtlSeconds }),
    });
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
  registerItemRoutes(app, deps.scoresRetention ? { scoresRetention: deps.scoresRetention } : {});
  registerSearchRoutes(app);
  registerNewRoutes(app);
  registerTopicRoutes(app);
  registerCompareRoutes(app);
  registerStatsRoutes(app);
  registerStreamRoutes(app, { trustProxy: deps.trustProxy ?? false });
  registerAdminRoutes(app, queues === undefined ? {} : { queues });
  registerAuthRoutes(app, { ...(deps.auth ?? {}), trustProxy: deps.trustProxy ?? false });
  registerWatchlistRoutes(app, queues === undefined ? {} : { queues });
  registerAlertRoutes(app);
  registerDigestRoutes(app);
  registerApiKeyRoutes(app, deps.apiKeyPepper === undefined ? {} : { pepper: deps.apiKeyPepper });
  registerUnsubscribeRoutes(
    app,
    deps.unsubscribeSecret === undefined ? {} : { secret: deps.unsubscribeSecret },
  );

  return app;
}
