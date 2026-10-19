import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RedisTokenBucket, redisKeys } from '@trendr/core';

// The 10-token burst lands within a few ms; the first refill cannot happen
// before the refill period (1 s) elapses, so any threshold well below 1 s
// separates the burst from the refilled grants.
const BURST_WINDOW_MS = 500;

describe('RedisTokenBucket over real Redis (spec §7.4 acceptance)', () => {
  let redis: Redis;
  const names: string[] = [];
  let counter = 0;

  function makeBucket(capacity: number, refillPerSec: number): RedisTokenBucket {
    counter += 1;
    const name = `int-tb-${process.pid}-${Date.now()}-${counter}`;
    names.push(name);
    return new RedisTokenBucket(redis, { name, capacity, refillPerSec });
  }

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL ?? '';
    if (redisUrl === '') {
      throw new Error('REDIS_URL is missing — run through `pnpm test:int`');
    }
    redis = new Redis(redisUrl);
    await redis.ping();
    // Warm the script cache so the first timed burst is not slowed by EVALSHA
    // loading on a cold connection.
    await makeBucket(1, 1).take();
  });

  afterAll(async () => {
    const keys = names.flatMap((name) => [redisKeys.rateBucket(name), redisKeys.ratePause(name)]);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    await redis.quit();
  });

  it('grants 10 tokens immediately to 20 concurrent takers and trickles the rest at 1/s', async () => {
    const bucket = makeBucket(10, 1);
    const startedAt = Date.now();
    const completedAt: number[] = [];

    await Promise.all(
      Array.from({ length: 20 }, async () => {
        await bucket.take();
        completedAt.push(Date.now() - startedAt);
      }),
    );

    expect(completedAt).toHaveLength(20);
    const sorted = [...completedAt].sort((a, b) => a - b);

    // Capacity burst: exactly the first 10 grants within the initial window.
    expect(sorted.filter((at) => at < BURST_WINDOW_MS)).toHaveLength(10);

    // Spec §18 (4.1): grants(t) <= capacity + refill * elapsed. Verifying it
    // per grant: the (i+1)-th grant cannot come earlier than its refill slot
    // (0.75 for scheduling slack).
    sorted.forEach((at, index) => {
      const grantNumber = index + 1;
      if (grantNumber > 10) {
        expect(at).toBeGreaterThanOrEqual((grantNumber - 10) * 1_000 * 0.75);
      }
    });

    // 10 refills at 1/s: the 20th grant lands around 10 s, safely under 15 s.
    expect(sorted[19] ?? 0).toBeGreaterThanOrEqual(9_000);
    expect(sorted[19] ?? 0).toBeLessThan(15_000);
  }, 30_000);

  it('pauseUntil holds every taker until the pause elapses', async () => {
    const bucket = makeBucket(100, 100);
    const pauseMs = 700;
    await bucket.pauseUntil(Date.now() + pauseMs);

    const startedAt = Date.now();
    await bucket.take();
    const waitedMs = Date.now() - startedAt;

    expect(waitedMs).toBeGreaterThanOrEqual(pauseMs - 100);
    expect(waitedMs).toBeLessThan(pauseMs + 500);
  }, 30_000);
});
