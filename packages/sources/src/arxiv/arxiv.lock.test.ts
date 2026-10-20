import type { Redis } from 'ioredis';
import { describe, expect, it, vi } from 'vitest';

import { createRedisArxivConnectionLock } from './arxiv.adapter.js';

/**
 * Spec §18 task 5.4 — `lock:arxiv:conn` is a cross-worker mutex: acquire with
 * SET NX PX 30000 and release only the token this caller owns.
 */

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('arXiv Redis connection lock (spec §7.3.5)', () => {
  it('acquires the documented key/TTL and releases the same token', async () => {
    const set = vi.fn(() => Promise.resolve('OK'));
    const evalScript = vi.fn(() => Promise.resolve(1));
    const redis = { set, eval: evalScript } as unknown as Redis;
    const lock = createRedisArxivConnectionLock(redis);

    await expect(lock.run(signal(), () => Promise.resolve('done'))).resolves.toBe('done');

    expect(set).toHaveBeenCalledWith('lock:arxiv:conn', expect.any(String), 'PX', 30_000, 'NX');
    const token = (set.mock.calls[0] as unknown[])[1];
    expect(evalScript).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1])'),
      1,
      'lock:arxiv:conn',
      token,
    );
  });

  it('releases the mutex when the request throws', async () => {
    const set = vi.fn(() => Promise.resolve('OK'));
    const evalScript = vi.fn(() => Promise.resolve(1));
    const redis = { set, eval: evalScript } as unknown as Redis;
    const lock = createRedisArxivConnectionLock(redis);

    await expect(lock.run(signal(), () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom',
    );
    expect(evalScript).toHaveBeenCalledTimes(1);
  });

  it('waits for a held lock before claiming it', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const set = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
      const evalScript = vi.fn(() => Promise.resolve(1));
      const redis = { set, eval: evalScript } as unknown as Redis;
      const lock = createRedisArxivConnectionLock(redis, { retryMs: 100 });

      const run = lock.run(signal(), () => Promise.resolve('done'));
      await vi.runAllTimersAsync();

      await expect(run).resolves.toBe('done');
      expect(set).toHaveBeenCalledTimes(2);
      expect(Date.now() - start).toBeGreaterThanOrEqual(100);
    } finally {
      vi.useRealTimers();
    }
  });
});
