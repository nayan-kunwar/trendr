import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection } from '@trendr/db';

import { buildApp } from '../../src/app.js';

/**
 * Readiness acceptance (spec §14.4) over the Testcontainers Postgres/Redis
 * fixture: the endpoint must observe real dependencies, including the
 * migration journal, and degrade when one is absent.
 */

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const REDIS_URL = process.env.REDIS_URL ?? '';

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

describe('readiness endpoint', () => {
  it('reports ready when Postgres, Redis and the migration journal are reachable', async () => {
    const app = await buildApp({ db: connection, redis, rateLimit: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: 'ready',
        checks: { db: 'ok', redis: 'ok', migrations: 'ok' },
      });
    } finally {
      await app.close();
    }
  });

  it('reports degraded when Redis is absent but Postgres is healthy', async () => {
    const app = await buildApp({ db: connection, rateLimit: false });
    try {
      const response = await app.inject({ method: 'GET', url: '/readyz' });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'degraded',
        checks: { db: 'ok', redis: 'error', migrations: 'ok' },
      });
    } finally {
      await app.close();
    }
  });
});
