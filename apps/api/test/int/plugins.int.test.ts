import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb, type Connection } from '@trendr/db';

import { buildApp } from '../../src/app.js';
import { CACHE_BREAKER_THRESHOLD } from '../../src/plugins/cache.js';

/**
 * Task 3.1 acceptance: the db/redis/cache/etag/rate-limit/openapi plugins over
 * real Postgres + Redis (spec §9.3, §9.4, §10.5), including the Swagger UI at
 * /docs and the OpenAPI 3.1 document at /openapi.json.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const DEPS = { corsOrigins: ['http://localhost:3000'], metricsToken: 'int-metrics-token' };

let connection: Connection;
let redis: Redis;

beforeAll(() => {
  connection = createDb(DATABASE_URL, { max: 2 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
});

afterAll(async () => {
  await connection.pool.end();
  redis.disconnect();
});

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

describe('api plugins over real Postgres + Redis (task 3.1)', () => {
  it('decorates app.db/app.pool and app.redis/app.redisSub', async () => {
    await withApp({ ...DEPS, db: connection, redis }, async (app) => {
      const result = await app.pool.query<{ ok: number }>('select 1 as ok');
      expect(result.rows[0]?.ok).toBe(1);
      await expect(app.redis.ping()).resolves.toBe('PONG');
      expect(app.redisSub).not.toBe(app.redis);
      expect(app.redisSub.status).toBe('ready');
    });
  });

  it('caches through Redis and invalidates (spec §9.3)', async () => {
    await withApp({ ...DEPS, db: connection, redis }, async (app) => {
      const key = 'int:item:cache';
      await redis.del(key);
      const load = vi.fn(() => Promise.resolve({ v: 42 }));

      await expect(app.cache.readThrough(key, 60, load)).resolves.toEqual({ v: 42 });
      await expect(app.cache.readThrough(key, 60, load)).resolves.toEqual({ v: 42 });
      expect(load).toHaveBeenCalledTimes(1);
      await expect(redis.get(key)).resolves.toBe(JSON.stringify({ v: 42 }));

      await app.cache.invalidate(key);
      await expect(app.cache.readThrough(key, 60, load)).resolves.toEqual({ v: 42 });
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  it('opens the circuit breaker after repeated Redis failures', async () => {
    await withApp({ ...DEPS, db: connection, redis }, async (app) => {
      const spy = vi.spyOn(app.redis, 'get').mockRejectedValue(new Error('redis down'));
      try {
        for (let i = 0; i < CACHE_BREAKER_THRESHOLD; i += 1) {
          await expect(
            app.cache.readThrough(`int:breaker:${i}`, 60, () => Promise.resolve('sql')),
          ).resolves.toBe('sql');
        }
        expect(app.cache.breakerState().open).toBe(true);

        const calls = spy.mock.calls.length;
        await expect(
          app.cache.readThrough('int:breaker:open', 60, () => Promise.resolve('sql')),
        ).resolves.toBe('sql');
        expect(spy.mock.calls.length).toBe(calls);
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('rate limits through the shared Redis store (spec §10.5)', async () => {
    const stale = await redis.keys('ratelimit:*');
    if (stale.length > 0) {
      await redis.del(...stale);
    }
    await withApp(
      { ...DEPS, db: connection, redis, rateLimit: { max: 2, timeWindowMs: 60_000 } },
      async (app) => {
        expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
        expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);

        const limited = await app.inject({ method: 'GET', url: '/healthz' });
        expect(limited.statusCode).toBe(429);
        expect(limited.headers['content-type']).toContain('application/problem+json');
        expect(limited.headers['retry-after']).toBeDefined();
        expect(limited.headers['ratelimit-limit']).toBe('2');

        const keys = await redis.keys('ratelimit:*');
        expect(keys.length).toBeGreaterThan(0);
        await redis.del(...keys);
      },
    );
  });

  it('serves /docs and the OpenAPI 3.1 document', async () => {
    await withApp({ ...DEPS, db: connection, redis }, async (app) => {
      const document = await app.inject({ method: 'GET', url: '/openapi.json' });
      expect(document.statusCode).toBe(200);
      expect(document.json<{ openapi: string }>().openapi).toBe('3.1.0');

      const docs = await app.inject({ method: 'GET', url: '/docs' });
      const location = docs.headers.location;
      const page =
        docs.statusCode === 302 && typeof location === 'string'
          ? await app.inject({ method: 'GET', url: location })
          : docs;
      expect(page.statusCode).toBe(200);
      expect(page.body.toLowerCase()).toContain('swagger');
    });
  });
});
