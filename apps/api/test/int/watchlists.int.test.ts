import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  insertScores,
  items,
  startRun,
  swapCurrentRun,
  upsertItems,
  users,
  watchlistItems,
  watchlists,
  type Connection,
  type ItemUpsert,
} from '@trendr/db';

import { buildApp } from '../../src/app.js';

/**
 * Task 7.2 acceptance over real Postgres + Redis: per-user watchlist CRUD,
 * caps (20 lists / 500 items), current 24h/7d score summaries, hot-tier
 * promotion on add, idempotent PUT, and IDOR safety — user B receives 404 for
 * every one of user A's watchlist routes.
 */

const PREFIX = `int-watchlists-${randomUUID().slice(0, 8)}`;
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const JWT_SECRET = 'int-watchlist-jwt-secret-0123456789abcdef';

let connection: Connection;
let redis: Redis;
let app: FastifyInstance;

beforeAll(async () => {
  connection = createDb(DATABASE_URL, { max: 4 });
  redis = new Redis(REDIS_URL, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
  app = await buildApp({
    db: connection,
    redis,
    jwtSecret: JWT_SECRET,
    rateLimit: { max: 1_000 },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await redis.quit();
  await connection.pool.end();
});

interface TestUser {
  id: string;
  token: string;
}

async function createUser(label: string): Promise<TestUser> {
  const [row] = await connection.db
    .insert(users)
    .values({
      email: `${PREFIX}-${label}@example.test`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (row === undefined) throw new Error('user insert returned no row');
  return {
    id: row.id,
    token: app.jwt.sign({ sub: row.id, role: row.role }),
  };
}

function auth(user: TestUser): { authorization: string } {
  return { authorization: `Bearer ${user.token}` };
}

async function createList(user: TestUser, name: string): Promise<{ id: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/me/watchlists',
    headers: auth(user),
    payload: { name },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<{ id: string }>();
}

function itemFixture(index: number): ItemUpsert {
  const externalId = `${PREFIX}-item-${index}`;
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: `Watchlist item ${index}`,
    description: `Fixture ${index}`,
    url: `https://example.test/${externalId}`,
    homepage: null,
    language: 'TypeScript',
    license: null,
    owner: PREFIX,
    primaryMetric: 'stars',
    upstreamCreatedAt: new Date('2024-01-01T00:00:00Z'),
    isArchived: false,
    metadata: {},
  };
}

async function seedScores(itemId: bigint): Promise<void> {
  const runId = await startRun(connection.db, {
    source: 'github',
    jobType: 'score',
    jobId: `${PREFIX}-score`,
    params: {},
  });
  await insertScores(connection.db, [
    {
      itemId,
      window: '24h',
      runId,
      source: 'github',
      computedAt: new Date(),
      delta: 42,
      base: 1000,
      relGrowth: 0.042,
      rawScore: 42,
      ageFactor: 1,
      confidence: 1,
      anomalyPenalty: 0,
      finalScore: 42,
      zScore: 1.5,
      percentile: 97.5,
      rankSource: 3,
      rankAll: 8,
    },
    {
      itemId,
      window: '7d',
      runId,
      source: 'github',
      computedAt: new Date(),
      delta: 210,
      base: 1000,
      relGrowth: 0.21,
      rawScore: 210,
      ageFactor: 1,
      confidence: 1,
      anomalyPenalty: 0,
      finalScore: 210,
      zScore: 2.1,
      percentile: 99,
      rankSource: 1,
      rankAll: 2,
    },
  ]);
  await swapCurrentRun(connection.db, {
    source: 'github',
    window: '24h',
    runId,
    computedAt: new Date(),
  });
  await swapCurrentRun(connection.db, {
    source: 'github',
    window: '7d',
    runId,
    computedAt: new Date(),
  });
}

describe('watchlists (task 7.2)', () => {
  it('creates a default list, promotes items, returns current scores, and renames', async () => {
    const user = await createUser('owner');
    const [item] = await upsertItems(connection.db, [itemFixture(1)]);
    if (item === undefined) throw new Error('item insert failed');
    await seedScores(item.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/me/watchlists',
      headers: auth(user),
      payload: { name: 'My Watchlist' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const list = created.json<{ id: string; isDefault: boolean; itemCount: number }>();
    expect(list).toMatchObject({ isDefault: true, itemCount: 0 });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/me/watchlists',
      headers: auth(user),
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json<{ watchlists: unknown[] }>().watchlists).toHaveLength(1);

    const added = await app.inject({
      method: 'PUT',
      url: `/v1/me/watchlists/${list.id}/items/${item.id}`,
      headers: auth(user),
    });
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json<{ added: boolean; watchlist: { itemCount: number } }>()).toMatchObject({
      added: true,
      watchlist: { itemCount: 1 },
    });

    const repeated = await app.inject({
      method: 'PUT',
      url: `/v1/me/watchlists/${list.id}/items/${item.id}`,
      headers: auth(user),
    });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json<{ added: boolean }>().added).toBe(false);

    const contents = await app.inject({
      method: 'GET',
      url: `/v1/me/watchlists/${list.id}/items`,
      headers: auth(user),
    });
    expect(contents.statusCode, contents.body).toBe(200);
    const body = contents.json<{
      items: {
        id: string;
        displayName: string;
        scores: {
          '24h': { delta: number; percentile: number; rankSource: number | null } | null;
          '7d': { delta: number } | null;
        };
      }[];
    }>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: item.id.toString(),
      displayName: 'Watchlist item 1',
      scores: {
        '24h': { delta: 42, percentile: 97.5, rankSource: 3 },
        '7d': { delta: 210 },
      },
    });

    const [promoted] = await connection.db
      .select({ tier: items.tier })
      .from(items)
      .where(eq(items.id, item.id));
    expect(promoted?.tier).toBe('hot');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/me/watchlists/${list.id}`,
      headers: auth(user),
      payload: { name: 'Renamed list' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<{ name: string }>().name).toBe('Renamed list');

    const duplicate = await createList(user, 'Another list');
    const conflict = await app.inject({
      method: 'PATCH',
      url: `/v1/me/watchlists/${duplicate.id}`,
      headers: auth(user),
      payload: { name: 'Renamed list' },
    });
    expect(conflict.statusCode).toBe(409);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/me/watchlists/${list.id}/items/${item.id}`,
      headers: auth(user),
    });
    expect(removed.statusCode).toBe(204);
    expect(
      (
        await app.inject({
          method: 'GET',
          url: `/v1/me/watchlists/${list.id}/items`,
          headers: auth(user),
        })
      ).json<{ items: unknown[] }>().items,
    ).toHaveLength(0);
  });

  it('returns 404 for every foreign watchlist operation (IDOR)', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const [item] = await upsertItems(connection.db, [itemFixture(2)]);
    if (item === undefined) throw new Error('item insert failed');
    const list = await createList(alice, 'Alice private');

    const requests = [
      { method: 'GET', url: `/v1/me/watchlists/${list.id}/items` },
      { method: 'PATCH', url: `/v1/me/watchlists/${list.id}`, payload: { name: 'stolen' } },
      { method: 'DELETE', url: `/v1/me/watchlists/${list.id}` },
      { method: 'PUT', url: `/v1/me/watchlists/${list.id}/items/${item.id}` },
      { method: 'DELETE', url: `/v1/me/watchlists/${list.id}/items/${item.id}` },
    ] as const;

    for (const request of requests) {
      const response = await app.inject({ ...request, headers: auth(bob) });
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(404);
    }

    const bobLists = await app.inject({
      method: 'GET',
      url: '/v1/me/watchlists',
      headers: auth(bob),
    });
    expect(bobLists.json<{ watchlists: unknown[] }>().watchlists).toHaveLength(0);

    const anonymous = await app.inject({
      method: 'GET',
      url: `/v1/me/watchlists/${list.id}/items`,
    });
    expect(anonymous.statusCode).toBe(401);

    const missing = await app.inject({
      method: 'GET',
      url: `/v1/me/watchlists/${randomUUID()}/items`,
      headers: auth(alice),
    });
    expect(missing.statusCode).toBe(404);
  });

  it('enforces 20 watchlists and 500 items per list', async () => {
    const user = await createUser('caps');
    for (let index = 0; index < 20; index += 1) {
      await createList(user, `List ${index}`);
    }
    const overflow = await app.inject({
      method: 'POST',
      url: '/v1/me/watchlists',
      headers: auth(user),
      payload: { name: 'List 20' },
    });
    expect(overflow.statusCode).toBe(409);

    const list = await connection.db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(eq(watchlists.userId, user.id))
      .limit(1);
    const watchlistId = list[0]?.id;
    if (watchlistId === undefined) throw new Error('cap user list missing');

    const fixtures = Array.from({ length: 501 }, (_, index) => itemFixture(100 + index));
    const seeded = await upsertItems(connection.db, fixtures);
    if (seeded.length !== 501) throw new Error('expected 501 seeded items');
    await connection.db.insert(watchlistItems).values(
      seeded.slice(0, 500).map((row) => ({
        watchlistId,
        itemId: row.id,
        addedAt: new Date(),
      })),
    );

    const overItemCap = await app.inject({
      method: 'PUT',
      url: `/v1/me/watchlists/${watchlistId}/items/${seeded[500]?.id.toString() ?? '0'}`,
      headers: auth(user),
    });
    expect(overItemCap.statusCode, overItemCap.body).toBe(409);
  });
});
