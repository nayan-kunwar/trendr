import type { Redis } from 'ioredis';

/**
 * L-1: fixed-window counters shared by the auth routes. Redis gets an atomic
 * Lua INCR+EXPIRE; when Redis is absent or down callers use a bounded
 * process-local map so a flood cannot grow memory without limit.
 */

/** Keep the Lua script atomic: both commands run in one Redis round trip. */
const INCR_WITH_TTL = `
local count = redis.call('INCR', KEYS[1])
if count == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

export const MEMORY_COUNTER_LIMIT = 5_000;

export interface CounterEntry {
  count: number;
  resetAt: number;
}

/** Minimal Redis surface so tests and tooling can supply a fake. */
export type CounterRedis = Pick<Redis, 'eval'>;

/**
 * Atomically increment `key` and ensure it expires. Returns null when Redis
 * fails so the caller can fall back to `bumpMemoryCounter` (L-1).
 */
export async function incrementWithTtl(
  redis: CounterRedis,
  key: string,
  ttlSeconds: number,
): Promise<number | null> {
  try {
    const result: unknown = await redis.eval(INCR_WITH_TTL, 1, key, String(ttlSeconds));
    return typeof result === 'number' ? result : null;
  } catch {
    return null;
  }
}

/**
 * Count one hit in a fixed window and answer whether it is within `max`.
 * Expired entries are pruned first; if the map is still full the oldest entry
 * is evicted, so `map.size` never exceeds `MEMORY_COUNTER_LIMIT` (L-1).
 */
export function bumpMemoryCounter(
  map: Map<string, CounterEntry>,
  key: string,
  nowMs: number,
  windowMs: number,
  max: number,
): boolean {
  const existing = map.get(key);
  if (existing !== undefined && existing.resetAt > nowMs) {
    existing.count += 1;
    return existing.count <= max;
  }

  if (map.size >= MEMORY_COUNTER_LIMIT) {
    for (const [candidate, entry] of map) {
      if (entry.resetAt <= nowMs) map.delete(candidate);
    }
  }
  while (map.size >= MEMORY_COUNTER_LIMIT) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }

  map.set(key, { count: 1, resetAt: nowMs + windowMs });
  return max > 0;
}
