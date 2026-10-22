import { setTimeout as sleep } from 'node:timers/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Redis } from 'ioredis';

import { redisKeys } from '../redis-keys.js';
import { RedisTokenBucket, type BucketSpec } from './token-bucket.js';

// The wait in `take()` is mocked out so tests never really sleep; the delay it
// was called with is asserted per test (vitest fake timers cannot intercept
// `node:timers/promises`).
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setTimeout: vi.fn(() => Promise.resolve(undefined)) };
});

interface FakeCommandDefinition {
  numberOfKeys?: number;
  lua?: string;
}

/** Minimal stand-in for `ioredis`: records `defineCommand` and scripted replies. */
class FakeRedis {
  readonly commands = new Map<string, FakeCommandDefinition>();
  readonly takeToken = vi.fn((): Promise<[number, number]> => Promise.resolve([1, 0]));
  readonly set = vi.fn<(...args: [string, string, 'PX', number]) => Promise<'OK'>>(() =>
    Promise.resolve('OK'),
  );

  defineCommand(name: string, definition: FakeCommandDefinition): void {
    this.commands.set(name, definition);
  }
}

function setup(overrides: Partial<BucketSpec> = {}): {
  bucket: RedisTokenBucket;
  redis: FakeRedis;
} {
  const redis = new FakeRedis();
  const bucket = new RedisTokenBucket(redis as unknown as Redis, {
    name: 'github:core',
    capacity: 500,
    refillPerSec: 1.25,
    ...overrides,
  });
  return { bucket, redis };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RedisTokenBucket (spec §7.4)', () => {
  it('registers the takeToken Lua script with two keys', () => {
    const { redis } = setup();
    const definition = redis.commands.get('takeToken');
    expect(definition?.numberOfKeys).toBe(2);
    expect(definition?.lua).toContain("redis.call('HMGET', KEYS[1], 'tokens', 'ts')");
    expect(definition?.lua).toContain("redis.call('PEXPIRE', KEYS[1], ttl)");
  });

  it('returns immediately when allowed and passes the bucket arguments', async () => {
    const { bucket, redis } = setup({ capacity: 10, refillPerSec: 2 });
    await bucket.take(3);
    expect(redis.takeToken).toHaveBeenCalledTimes(1);
    expect(redis.takeToken).toHaveBeenCalledWith(
      redisKeys.rateBucket('github:core'),
      redisKeys.ratePause('github:core'),
      10,
      0.002,
      3,
      expect.any(Number),
      3_600_000,
    );
    expect(vi.mocked(sleep)).not.toHaveBeenCalled();
  });

  it('waits the advertised delay (plus jitter) and retries until allowed', async () => {
    const { bucket, redis } = setup();
    redis.takeToken.mockResolvedValueOnce([0, 5]).mockResolvedValueOnce([1, 0]);
    await bucket.take();
    expect(redis.takeToken).toHaveBeenCalledTimes(2);
    const waitMs = vi.mocked(sleep).mock.calls[0]?.[0] ?? 0;
    expect(waitMs).toBeGreaterThanOrEqual(5);
    expect(waitMs).toBeLessThan(5 + 50);
  });

  it('reports the blocked time once when a take eventually succeeds', async () => {
    const redis = new FakeRedis();
    const onWait = vi.fn();
    const bucket = new RedisTokenBucket(
      redis as unknown as Redis,
      { name: 'github:core', capacity: 500, refillPerSec: 1.25 },
      onWait,
    );
    redis.takeToken.mockResolvedValueOnce([0, 5]).mockResolvedValueOnce([1, 0]);
    await bucket.take();
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledWith('github:core', expect.any(Number));
    expect(onWait.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(0);
  });

  it('does not report a wait when the first take is allowed', async () => {
    const redis = new FakeRedis();
    const onWait = vi.fn();
    const bucket = new RedisTokenBucket(
      redis as unknown as Redis,
      { name: 'github:core', capacity: 500, refillPerSec: 1.25 },
      onWait,
    );
    await bucket.take();
    expect(onWait).not.toHaveBeenCalled();
  });

  it('caps a single wait at 60 s', async () => {
    const { bucket, redis } = setup();
    redis.takeToken.mockResolvedValueOnce([0, 10_000_000]).mockResolvedValueOnce([1, 0]);
    await bucket.take();
    expect(vi.mocked(sleep)).toHaveBeenCalledWith(60_000, undefined, undefined);
  });

  it('rejects without touching Redis when the signal is already aborted', async () => {
    const { bucket, redis } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(bucket.take(1, controller.signal)).rejects.toThrow();
    expect(redis.takeToken).not.toHaveBeenCalled();
  });

  it('passes an active signal to the wait so aborts interrupt it', async () => {
    const { bucket, redis } = setup();
    redis.takeToken.mockResolvedValueOnce([0, 1]).mockResolvedValueOnce([1, 0]);
    const controller = new AbortController();
    await bucket.take(1, controller.signal);
    const options = vi.mocked(sleep).mock.calls[0]?.[2];
    expect(options?.signal).toBe(controller.signal);
  });

  it('pauseUntil sets the pause key with a PX ttl until the requested time', async () => {
    const { bucket, redis } = setup();
    const until = Date.now() + 30_000;
    await bucket.pauseUntil(until);
    const call = redis.set.mock.calls[0];
    expect(call?.[0]).toBe(redisKeys.ratePause('github:core'));
    expect(call?.[1]).toBe(String(until));
    expect(call?.[2]).toBe('PX');
    const ttl = call?.[3] ?? 0;
    expect(ttl).toBeGreaterThan(29_000);
    expect(ttl).toBeLessThanOrEqual(30_000);
  });

  it('clamps the pause ttl to 1 ms when the instant already passed', async () => {
    const { bucket, redis } = setup();
    await bucket.pauseUntil(Date.now() - 5_000);
    expect(redis.set).toHaveBeenCalledWith(
      redisKeys.ratePause('github:core'),
      expect.any(String),
      'PX',
      1,
    );
  });
});
