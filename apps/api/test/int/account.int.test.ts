import { randomUUID } from 'node:crypto';

import { eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashApiKey, signUnsubscribeToken } from '@trendr/core';
import {
  alerts,
  apiKeys,
  createDb,
  digestSubscriptions,
  items,
  upsertItems,
  users,
  watchlists,
  type Connection,
  type ItemUpsert,
} from '@trendr/db';

import { buildApp } from '../../src/app.js';

/**
 * Tasks 7.4/7.5 acceptance over real Postgres + Redis: digest preferences,
 * RFC 8058 unsubscribe (200 when repeated), and API-key lifecycle — show the
 * key once, enforce the five-active-key cap, revoke, and IDOR safety.
 */

const PREFIX = `int-account-${randomUUID().slice(0, 8)}`;
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';
const JWT_SECRET = 'int-account-jwt-secret-0123456789abcdef';
const PEPPER = 'int-account-api-key-pepper-0123456789abcdef';
const UNSUBSCRIBE_SECRET = 'int-account-unsubscribe-secret-0123456789abcdef';

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
    unsubscribeSecret: UNSUBSCRIBE_SECRET,
    apiKeyPepper: PEPPER,
  });
  await app.ready();
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await app.close();
  await redis.quit();
  await connection.pool.end();
});

async function cleanup(): Promise<void> {
  await connection.db.delete(users).where(like(users.email, `${PREFIX}%`));
  await connection.db.delete(items).where(eq(items.owner, PREFIX));
}

interface TestUser {
  id: string;
  token: string;
}

async function createUser(label: string): Promise<TestUser> {
  const [row] = await connection.db
    .insert(users)
    .values({
      email: `${PREFIX}-${label}-${randomUUID().slice(0, 6)}@example.test`,
      emailVerifiedAt: new Date(),
    })
    .returning();
  if (row === undefined) throw new Error('user insert failed');
  return { id: row.id, token: app.jwt.sign({ sub: row.id, role: row.role }) };
}

function auth(user: TestUser): { authorization: string } {
  return { authorization: `Bearer ${user.token}` };
}

function itemFixture(): ItemUpsert {
  const externalId = `${PREFIX}-item`;
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId: null,
    name: externalId,
    displayName: 'Account fixture',
    description: null,
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

describe('digest preferences and unsubscribe (task 7.4)', () => {
  it('upserts preferences and unsubscribes idempotently through RFC 8058', async () => {
    const user = await createUser('a');
    const other = await createUser('b');

    const empty = await app.inject({
      method: 'GET',
      url: '/v1/me/digest',
      headers: auth(user),
    });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json<{ subscription: unknown }>().subscription).toBeNull();

    const put = await app.inject({
      method: 'PUT',
      url: '/v1/me/digest',
      headers: auth(user),
      payload: {
        sources: ['github', 'mcp'],
        topics: ['AI', 'ai', 'developer-tools'],
        includeWatchlist: true,
        dayOfWeek: 1,
        enabled: true,
      },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toMatchObject({
      subscription: {
        sources: ['github', 'mcp'],
        topics: ['ai', 'developer-tools'],
        includeWatchlist: true,
        dayOfWeek: 1,
        enabled: true,
        unsubscribedAt: null,
      },
    });

    const otherView = await app.inject({
      method: 'GET',
      url: '/v1/me/digest',
      headers: auth(other),
    });
    expect(otherView.json<{ subscription: unknown }>().subscription).toBeNull();

    const token = signUnsubscribeToken({
      userId: user.id,
      purpose: 'digest',
      expiresAt: Date.now() + 60_000,
      secret: UNSUBSCRIBE_SECRET,
    });
    const preview = await app.inject({
      method: 'GET',
      url: `/v1/unsubscribe?token=${encodeURIComponent(token)}`,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    expect(preview.json()).toEqual({ ok: true, purpose: 'digest' });
    const stillEnabled = await connection.db
      .select()
      .from(digestSubscriptions)
      .where(eq(digestSubscriptions.userId, user.id));
    expect(stillEnabled[0]?.enabled).toBe(true);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/unsubscribe?token=${encodeURIComponent(token)}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({ ok: true, purpose: 'digest' });
    }

    const [row] = await connection.db
      .select()
      .from(digestSubscriptions)
      .where(eq(digestSubscriptions.userId, user.id));
    expect(row?.enabled).toBe(false);
    expect(row?.unsubscribedAt).not.toBeNull();

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/unsubscribe?token=not-a-valid-token',
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('alerts/all unsubscribe disables alert rules', async () => {
    const user = await createUser('a');
    const [item] = await upsertItems(connection.db, [itemFixture()]);
    if (item === undefined) throw new Error('item insert failed');
    const [alert] = await connection.db
      .insert(alerts)
      .values({
        userId: user.id,
        type: 'threshold_crossed',
        itemId: item.id,
        watchlistId: null,
        window: '24h',
        params: { metric: 'stars', value: 100 },
        cooldownHours: 24,
        enabled: true,
      })
      .returning();
    if (alert === undefined) throw new Error('alert insert failed');

    const token = signUnsubscribeToken({
      userId: user.id,
      purpose: 'all',
      expiresAt: Date.now() + 60_000,
      secret: UNSUBSCRIBE_SECRET,
    });
    const response = await app.inject({
      method: 'POST',
      url: `/v1/unsubscribe?token=${encodeURIComponent(token)}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    const [updated] = await connection.db.select().from(alerts).where(eq(alerts.id, alert.id));
    expect(updated?.enabled).toBe(false);
  });
});

describe('alert rule CRUD (task 7.3)', () => {
  it('creates all target shapes, applies defaults, toggles, and enforces IDOR', async () => {
    const owner = await createUser('a');
    const other = await createUser('b');
    const [item] = await upsertItems(connection.db, [itemFixture()]);
    if (item === undefined) throw new Error('item insert failed');
    const [list] = await connection.db
      .insert(watchlists)
      .values({ userId: owner.id, name: 'Alert target' })
      .returning();
    if (list === undefined) throw new Error('watchlist insert failed');

    const itemRule = await app.inject({
      method: 'POST',
      url: '/v1/me/alerts',
      headers: auth(owner),
      payload: { itemId: item.id.toString(), params: { type: 'velocity_spike' } },
    });
    expect(itemRule.statusCode, itemRule.body).toBe(201);
    const itemAlert = itemRule.json<{
      id: string;
      type: string;
      itemId: string;
      window: string;
      cooldownHours: number;
      params: Record<string, unknown>;
      enabled: boolean;
    }>();
    expect(itemAlert).toMatchObject({
      type: 'velocity_spike',
      itemId: item.id.toString(),
      window: '24h',
      cooldownHours: 24,
      enabled: true,
      params: { minPercentile: 95, minDeltaMultiple: 3 },
    });

    const watchlistRule = await app.inject({
      method: 'POST',
      url: '/v1/me/alerts',
      headers: auth(owner),
      payload: {
        watchlistId: list.id,
        window: '7d',
        params: { type: 'threshold_crossed', metric: 'stars', value: 1_000 },
      },
    });
    expect(watchlistRule.statusCode, watchlistRule.body).toBe(201);

    const rankRule = await app.inject({
      method: 'POST',
      url: '/v1/me/alerts',
      headers: auth(owner),
      payload: { params: { type: 'rank_entered', topN: 10, scope: 'all' } },
    });
    expect(rankRule.statusCode, rankRule.body).toBe(201);
    expect(rankRule.json<{ itemId: string | null; watchlistId: string | null }>()).toMatchObject({
      itemId: null,
      watchlistId: null,
    });

    const invalidTarget = await app.inject({
      method: 'POST',
      url: '/v1/me/alerts',
      headers: auth(owner),
      payload: {
        itemId: item.id.toString(),
        params: { type: 'rank_entered', topN: 10, scope: 'all' },
      },
    });
    expect(invalidTarget.statusCode).toBe(400);

    const foreignTarget = await app.inject({
      method: 'POST',
      url: '/v1/me/alerts',
      headers: auth(owner),
      payload: { watchlistId: randomUUID(), params: { type: 'new_alias' } },
    });
    expect(foreignTarget.statusCode).toBe(404);

    const listResponse = await app.inject({
      method: 'GET',
      url: '/v1/me/alerts',
      headers: auth(owner),
    });
    expect(listResponse.statusCode, listResponse.body).toBe(200);
    expect(listResponse.json<{ alerts: unknown[] }>().alerts).toHaveLength(3);

    const paused = await app.inject({
      method: 'PATCH',
      url: `/v1/me/alerts/${itemAlert.id}`,
      headers: auth(owner),
      payload: { enabled: false },
    });
    expect(paused.statusCode, paused.body).toBe(200);
    expect(paused.json<{ enabled: boolean }>().enabled).toBe(false);

    const foreignPatch = await app.inject({
      method: 'PATCH',
      url: `/v1/me/alerts/${itemAlert.id}`,
      headers: auth(other),
      payload: { enabled: true },
    });
    expect(foreignPatch.statusCode).toBe(404);

    const foreignDelete = await app.inject({
      method: 'DELETE',
      url: `/v1/me/alerts/${itemAlert.id}`,
      headers: auth(other),
    });
    expect(foreignDelete.statusCode).toBe(404);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/me/alerts/${itemAlert.id}`,
      headers: auth(owner),
    });
    expect(deleted.statusCode).toBe(204);
  });
});

describe('API key lifecycle (task 7.5)', () => {
  it('shows the key once, lists prefixes, caps active keys and revokes with IDOR safety', async () => {
    const owner = await createUser('a');
    const other = await createUser('b');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/me/api-keys',
      headers: auth(owner),
      payload: { name: 'MCP server', expiresInDays: 30 },
    });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{
      key: string;
      apiKey: {
        id: string;
        prefix: string;
        scopes: string[];
        lastUsedAt: string | null;
        expiresAt: string | null;
      };
    }>();
    expect(body.key).toMatch(/^dt_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(body.apiKey.prefix).toBe(body.key.slice(0, -33));
    expect(body.apiKey.scopes).toEqual(['read']);
    expect(body.apiKey.expiresAt).not.toBeNull();

    const [stored] = await connection.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, body.apiKey.id));
    expect(stored?.keyHash).toEqual(hashApiKey(PEPPER, body.key));

    const list = await app.inject({
      method: 'GET',
      url: '/v1/me/api-keys',
      headers: auth(owner),
    });
    expect(list.statusCode, list.body).toBe(200);
    const listed = list.json<{ apiKeys: { prefix: string; key?: string }[] }>();
    expect(listed.apiKeys).toHaveLength(1);
    expect(listed.apiKeys[0]?.prefix).toBe(body.apiKey.prefix);
    expect(listed.apiKeys[0]).not.toHaveProperty('key');

    const duplicate = await app.inject({
      method: 'POST',
      url: '/v1/me/api-keys',
      headers: auth(owner),
      payload: { name: 'MCP server', expiresInDays: 30 },
    });
    expect(duplicate.statusCode).toBe(409);

    for (let index = 2; index <= 5; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/me/api-keys',
        headers: auth(owner),
        payload: { name: `Key ${index}` },
      });
      expect(response.statusCode, response.body).toBe(201);
    }
    const overCap = await app.inject({
      method: 'POST',
      url: '/v1/me/api-keys',
      headers: auth(owner),
      payload: { name: 'Key 6' },
    });
    expect(overCap.statusCode).toBe(409);

    const foreignRevoke = await app.inject({
      method: 'DELETE',
      url: `/v1/me/api-keys/${body.apiKey.id}`,
      headers: auth(other),
    });
    expect(foreignRevoke.statusCode).toBe(404);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/me/api-keys/${body.apiKey.id}`,
      headers: auth(owner),
    });
    expect(revoked.statusCode).toBe(204);
    const [revokedRow] = await connection.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, body.apiKey.id));
    expect(revokedRow?.revokedAt).not.toBeNull();

    const afterRevoke = await app.inject({
      method: 'GET',
      url: '/v1/me/api-keys',
      headers: auth(owner),
    });
    const after = afterRevoke.json<{ apiKeys: { id: string; revokedAt: string | null }[] }>();
    expect(after.apiKeys.find((key) => key.id === body.apiKey.id)?.revokedAt).not.toBeNull();

    const replacement = await app.inject({
      method: 'POST',
      url: '/v1/me/api-keys',
      headers: auth(owner),
      payload: { name: 'Replacement' },
    });
    expect(replacement.statusCode, replacement.body).toBe(201);
  });
});
