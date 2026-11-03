import { afterEach, describe, expect, it, vi } from 'vitest';

import { startLockRenewal } from '../../src/scoring/run-scoring.js';

/**
 * M-3: the scoring lock is a lease. `runScoring` could take longer than the
 * 120 s TTL (a full all-board rebuild), and the old code never renewed it — a
 * second worker could then start a concurrent run for the same source. The
 * renewal helper extends the lock only while this job still owns it.
 */

interface EvalCall {
  args: unknown[];
}

function fakeRedis(): { eval: ReturnType<typeof vi.fn>; calls: EvalCall[] } {
  const calls: EvalCall[] = [];
  const evalFn = vi.fn((...args: unknown[]) => {
    calls.push({ args });
    return Promise.resolve(1);
  });
  return { eval: evalFn, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('scoring lock renewal (M-3)', () => {
  it('renews on the configured cadence and stops when asked', async () => {
    vi.useFakeTimers();
    const redis = fakeRedis();
    const stop = startLockRenewal(redis, 'lock:score:github', 'job-1');

    await vi.advanceTimersByTimeAsync(29_000);
    expect(redis.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(redis.calls).toHaveLength(1);
    // Compare-and-pexpire: the script only extends the lock this job owns.
    expect(redis.calls[0]?.args.slice(0, 4)).toEqual([
      expect.stringContaining("redis.call('get'"),
      1,
      'lock:score:github',
      'job-1',
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(redis.calls).toHaveLength(3);

    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(redis.calls).toHaveLength(3);
  });

  it('logs a failed renewal without throwing', async () => {
    vi.useFakeTimers();
    const error = new Error('redis down');
    const redis = { eval: vi.fn(async () => Promise.reject(error)) };
    const logger = { warn: vi.fn() };
    const stop = startLockRenewal(redis, 'lock:score:npm', 'job-2', logger);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    stop();
  });
});
