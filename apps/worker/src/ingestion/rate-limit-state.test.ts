import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@trendr/logger';

import {
  RATE_LIMIT_STATE_TTL_SEC,
  persistRateLimitState,
  type RateLimitStateStore,
} from './rate-limit-state.js';

function fakeStore() {
  const writes: { key: string; fields: Record<string, string> }[] = [];
  const expires: { key: string; seconds: number }[] = [];
  const store: RateLimitStateStore = {
    hset: (key, fields) => {
      writes.push({ key, fields });
      return Promise.resolve(1);
    },
    expire: (key, seconds) => {
      expires.push({ key, seconds });
      return Promise.resolve(1);
    },
  };
  return { store, writes, expires };
}

describe('persistRateLimitState (spec §10.1 admin rate-limits)', () => {
  it('stores the last upstream headers under rl:last:{source}:{resource}', async () => {
    const { store, writes, expires } = fakeStore();
    const resetAt = new Date('2026-10-19T12:00:00.000Z');

    await persistRateLimitState(store, 'github', { resource: 'search', remaining: 17, resetAt });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.key).toBe('rl:last:github:search');
    expect(writes[0]?.fields).toMatchObject({
      remaining: '17',
      resetAt: '2026-10-19T12:00:00.000Z',
    });
    expect(writes[0]?.fields.observedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(expires).toEqual([{ key: 'rl:last:github:search', seconds: RATE_LIMIT_STATE_TTL_SEC }]);
  });

  it('omits resetAt when upstream did not provide one', async () => {
    const { store, writes } = fakeStore();

    await persistRateLimitState(store, 'npm', { resource: 'core', remaining: 0, resetAt: null });

    expect(writes[0]?.key).toBe('rl:last:npm:core');
    expect(writes[0]?.fields).not.toHaveProperty('resetAt');
  });

  it('never fails the ingest run when Redis is down', async () => {
    const warn = vi.fn();
    const store: RateLimitStateStore = {
      hset: () => Promise.reject(new Error('redis down')),
      expire: () => Promise.resolve(1),
    };

    await expect(
      persistRateLimitState(store, 'github', { resource: 'core', remaining: 1, resetAt: null }, {
        warn,
      } as unknown as Logger),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'rl:last:github:core' }),
      'rate-limit state not persisted',
    );
  });
});
