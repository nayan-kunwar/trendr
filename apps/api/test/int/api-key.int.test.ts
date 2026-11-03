import { randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConflictError, hashApiKey, redisKeys } from '@trendr/core';
import { apiKeys, countActiveApiKeysForUser, createDb, users, type Connection } from '@trendr/db';

import { buildApp } from '../../src/app.js';
import {
  createApiKeyForCurrentUser,
  revokeApiKeyForCurrentUser,
} from '../../src/services/api-key.service.js';

/**
 * Task 3.5 acceptance over real Postgres + Redis: the 61st anonymous request
 * in a minute gets 429 + `Retry-After`, a valid `X-API-Key` raises the limit,
 * and the api-key plugin's lookup/HMAC/revocation/debounce rules hold
 * (spec §10.5, §15).
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';

/** Own pepper: the seeded key uses a different one and can never authenticate here. */
const PEPPER = 'int-api-key-pepper-0123456789abcdef';
const EMAIL_PREFIX = 'int-apikey-';
const SECRET_SUFFIX = 'abcdef0123456789abcdef0123456789';
const DEPS = { corsOrigins: ['http://localhost:3000'], metricsToken: 'int-metrics-token' };

/** `dt_live_intkeyNN_<32 base62>` — NN keeps every fixture's prefix unique. */
function keyMaterial(n: number): { raw: string; prefix: string } {
  const prefix = `dt_live_intkey${String(n).padStart(2, '0')}`;
  return { raw: `${prefix}_${SECRET_SUFFIX}`, prefix };
}

const key1 = keyMaterial(1);
const key2 = keyMaterial(2);
const key3 = keyMaterial(3);

let connection: Connection;
let redis: Redis;
let primaryKeyId = '';
let ownerId = '';

beforeAll(async () => {
  connection = createDb(DATABASE_URL, { max: 2 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  await cleanup();

  const db = connection.db;
  const insertedUsers = await db
    .insert(users)
    .values({ email: `${EMAIL_PREFIX}${randomUUID()}@example.test`, displayName: 'Int API key' })
    .returning({ id: users.id });
  const userId = insertedUsers[0]?.id;
  if (userId === undefined) {
    throw new Error('failed to insert int api-key user');
  }
  ownerId = userId;

  const primary = await db
    .insert(apiKeys)
    .values({
      userId,
      name: 'int primary',
      prefix: key1.prefix,
      keyHash: hashApiKey(PEPPER, key1.raw),
      scopes: ['read'],
      rateLimitPerMin: 61,
    })
    .returning({ id: apiKeys.id });
  primaryKeyId = primary[0]?.id ?? '';

  await db.insert(apiKeys).values({
    userId,
    name: 'int revoked',
    prefix: key2.prefix,
    keyHash: hashApiKey(PEPPER, key2.raw),
    revokedAt: new Date(),
  });
  await db.insert(apiKeys).values({
    userId,
    name: 'int expired',
    prefix: key3.prefix,
    keyHash: hashApiKey(PEPPER, key3.raw),
    expiresAt: new Date(Date.now() - 60_000),
  });
});

afterAll(async () => {
  await cleanup();
  await connection.pool.end();
  redis.disconnect();
});

/** The seed int test leaves its own key + counters behind; fixtures are marker-scoped. */
async function cleanup(): Promise<void> {
  await connection.db.delete(users).where(like(users.email, `${EMAIL_PREFIX}%`));
  await deleteRedisKeys('apirl:*');
  await deleteRedisKeys('apikey:last-used:*');
}

async function deleteRedisKeys(pattern: string): Promise<void> {
  const keys = await redis.keys(pattern);
  if (keys.length > 0) {
    await redis.del(...keys);
  }
}

async function resetRateLimitCounters(): Promise<void> {
  await deleteRedisKeys('apirl:*');
}

async function readLastUsedAt(id: string): Promise<Date | null> {
  const rows = await connection.db
    .select({ lastUsedAt: apiKeys.lastUsedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);
  return rows[0]?.lastUsedAt ?? null;
}

async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildApp({ ...DEPS, db: connection, redis, apiKeyPepper: PEPPER });
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

describe('X-API-Key auth and rate-limit tiers (task 3.5)', () => {
  it('limits the 61st anonymous request in a minute with 429 + Retry-After', async () => {
    await resetRateLimitCounters();
    await withApp(async (app) => {
      for (let index = 0; index < 60; index += 1) {
        const ok = await app.inject({ method: 'GET', url: '/healthz' });
        expect(ok.statusCode).toBe(200);
      }

      const limited = await app.inject({ method: 'GET', url: '/healthz' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['content-type']).toContain('application/problem+json');
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.headers['ratelimit-limit']).toBe('60');
      expect(limited.json<{ type: string; status: number }>()).toMatchObject({
        type: 'https://trendr.dev/problems/rate-limited',
        status: 429,
      });
    });
    await resetRateLimitCounters();
  });

  it('raises the limit for a valid key and keeps its own counter', async () => {
    await resetRateLimitCounters();
    await withApp(async (app) => {
      for (let index = 0; index < 61; index += 1) {
        const response = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-api-key': key1.raw },
        });
        expect(response.statusCode, `request ${index + 1}`).toBe(200);
        if (index === 0) {
          expect(response.headers['ratelimit-limit']).toBe('61');
        }
      }
      expect((await redis.keys(`apirl:key:${primaryKeyId}`)).length).toBe(1);

      const overBudget = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-api-key': key1.raw },
      });
      expect(overBudget.statusCode).toBe(429);
      expect(overBudget.headers['retry-after']).toBeDefined();

      // Keyed traffic never consumes the anonymous IP counter.
      const anonymous = await app.inject({ method: 'GET', url: '/healthz' });
      expect(anonymous.statusCode).toBe(200);
      expect(anonymous.headers['ratelimit-limit']).toBe('60');
    });
    await resetRateLimitCounters();
  });

  it('rejects malformed, unknown, revoked, expired and mismatched keys with 401', async () => {
    await withApp(async (app) => {
      const cases: [string, string][] = [
        ['empty', ''],
        ['malformed', 'not-a-key'],
        ['wrong shape', `dt_live_intkey10_${SECRET_SUFFIX.slice(1)}`],
        ['unknown prefix', keyMaterial(9).raw],
        ['wrong secret', `${key1.raw.slice(0, -1)}z`],
        ['revoked', key2.raw],
        ['expired', key3.raw],
      ];
      for (const [label, key] of cases) {
        const response = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-api-key': key },
        });
        expect(response.statusCode, label).toBe(401);
        expect(response.headers['content-type'], label).toContain('application/problem+json');
        expect(response.json<{ type: string; status: number }>(), label).toMatchObject({
          type: 'https://trendr.dev/problems/unauthorized',
          status: 401,
        });
      }
    });
  });

  it('caches prefix lookups and drops the cache on revoke (M-2)', async () => {
    await resetRateLimitCounters();
    const raw = `dt_live_intcache_${SECRET_SUFFIX}`;
    const prefix = 'dt_live_intcache';
    const [created] = await connection.db
      .insert(apiKeys)
      .values({
        userId: ownerId,
        name: 'int cache',
        prefix,
        keyHash: hashApiKey(PEPPER, raw),
        scopes: ['read'],
      })
      .returning({ id: apiKeys.id });
    const keyId = created?.id;
    if (keyId === undefined) throw new Error('failed to insert cache fixture');
    const cacheKey = redisKeys.apiKeyLookup(prefix);
    await redis.del(cacheKey);

    try {
      await withApp(async (app) => {
        const first = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-api-key': raw },
        });
        expect(first.statusCode).toBe(200);

        const cached = await redis.get(cacheKey);
        expect(cached).not.toBeNull();
        const ttl = await redis.ttl(cacheKey);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(60);

        await revokeApiKeyForCurrentUser(
          { db: connection.db, pepper: PEPPER, redis },
          ownerId,
          keyId,
        );
        expect(await redis.get(cacheKey)).toBeNull();

        const afterRevoke = await app.inject({
          method: 'GET',
          url: '/healthz',
          headers: { 'x-api-key': raw },
        });
        expect(afterRevoke.statusCode).toBe(401);
      });
    } finally {
      await connection.db.delete(apiKeys).where(eq(apiKeys.id, keyId));
      await redis.del(cacheKey);
    }
  });

  it('serializes parallel creates at the five-key cap (L-4)', async () => {
    const [fresh] = await connection.db
      .insert(users)
      .values({
        email: `${EMAIL_PREFIX}race-${randomUUID()}@example.test`,
        displayName: 'Int API key race',
      })
      .returning({ id: users.id });
    const raceUser = fresh?.id;
    if (raceUser === undefined) throw new Error('failed to insert race user');

    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          createApiKeyForCurrentUser({ db: connection.db, pepper: PEPPER }, raceUser, {
            name: `race ${index}`,
          }),
        ),
      );
      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      expect(fulfilled).toHaveLength(5);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.reason).toBeInstanceOf(ConflictError);
      expect(await countActiveApiKeysForUser(connection.db, raceUser)).toBe(5);
    } finally {
      await connection.db.delete(apiKeys).where(eq(apiKeys.userId, raceUser));
      await connection.db.delete(users).where(eq(users.id, raceUser));
    }
  });

  it('touches last_used_at at most once per minute (Redis debounce)', async () => {
    await resetRateLimitCounters();
    await redis.del(redisKeys.apiKeyLastUsed(primaryKeyId));
    await connection.db
      .update(apiKeys)
      .set({ lastUsedAt: null })
      .where(eq(apiKeys.id, primaryKeyId));

    await withApp(async (app) => {
      const first = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-api-key': key1.raw },
      });
      expect(first.statusCode).toBe(200);
      const afterFirst = await readLastUsedAt(primaryKeyId);
      expect(afterFirst).not.toBeNull();
      expect(await redis.exists(redisKeys.apiKeyLastUsed(primaryKeyId))).toBe(1);
      const ttl = await redis.ttl(redisKeys.apiKeyLastUsed(primaryKeyId));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(60);

      const second = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-api-key': key1.raw },
      });
      expect(second.statusCode).toBe(200);
      expect((await readLastUsedAt(primaryKeyId))?.getTime()).toBe(afterFirst?.getTime());

      // Once the debounce window lapses, the next request writes again.
      await redis.del(redisKeys.apiKeyLastUsed(primaryKeyId));
      await connection.db
        .update(apiKeys)
        .set({ lastUsedAt: null })
        .where(eq(apiKeys.id, primaryKeyId));
      const third = await app.inject({
        method: 'GET',
        url: '/healthz',
        headers: { 'x-api-key': key1.raw },
      });
      expect(third.statusCode).toBe(200);
      expect(await readLastUsedAt(primaryKeyId)).not.toBeNull();
    });
  });
});
