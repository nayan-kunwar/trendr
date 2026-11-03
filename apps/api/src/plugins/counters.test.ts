import { describe, expect, it, vi } from 'vitest';

import {
  MEMORY_COUNTER_LIMIT,
  bumpMemoryCounter,
  incrementWithTtl,
  type CounterEntry,
} from './counters.js';

describe('atomic Redis counters (L-1)', () => {
  it('sets the TTL in the same Lua script as INCR', async () => {
    const evalMock = vi.fn().mockResolvedValue(1);
    const count = await incrementWithTtl({ eval: evalMock }, 'apirl:test', 60);
    expect(count).toBe(1);
    const [script, keys, key, ttl] = evalMock.mock.calls[0] as [string, number, string, string];
    expect(script).toContain("redis.call('INCR'");
    expect(script).toContain("redis.call('EXPIRE'");
    expect(keys).toBe(1);
    expect(key).toBe('apirl:test');
    expect(ttl).toBe('60');
  });

  it('returns null when Redis fails so callers can fall back', async () => {
    const evalMock = vi.fn().mockRejectedValue(new Error('redis down'));
    await expect(incrementWithTtl({ eval: evalMock }, 'apirl:test', 60)).resolves.toBeNull();
  });
});

describe('bounded in-memory fallback counters (L-1)', () => {
  it('counts within a window and resets after it', () => {
    const map = new Map<string, CounterEntry>();
    expect(bumpMemoryCounter(map, 'a', 1_000, 60_000, 2)).toBe(true);
    expect(bumpMemoryCounter(map, 'a', 1_001, 60_000, 2)).toBe(true);
    expect(bumpMemoryCounter(map, 'a', 1_002, 60_000, 2)).toBe(false);
    expect(bumpMemoryCounter(map, 'a', 61_000, 60_000, 2)).toBe(true);
  });

  it('prunes expired entries before evicting a live one', () => {
    const map = new Map<string, CounterEntry>();
    for (let index = 0; index < MEMORY_COUNTER_LIMIT; index += 1) {
      map.set(`old-${index}`, { count: 1, resetAt: 0 });
    }
    expect(bumpMemoryCounter(map, 'fresh', 1_000, 60_000, 1)).toBe(true);
    expect(map.size).toBe(1);
    expect(map.has('fresh')).toBe(true);
  });

  it('never grows past the cap when every entry is live', () => {
    const map = new Map<string, CounterEntry>();
    for (let index = 0; index < MEMORY_COUNTER_LIMIT; index += 1) {
      map.set(`live-${index}`, { count: 1, resetAt: 1_000_000 });
    }
    expect(bumpMemoryCounter(map, 'newest', 1_000, 60_000, 1)).toBe(true);
    expect(map.size).toBe(MEMORY_COUNTER_LIMIT);
    expect(map.has('live-0')).toBe(false);
    expect(map.has('newest')).toBe(true);
  });
});
