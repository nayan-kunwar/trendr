import { redisKeys, type Source } from '@trendr/core';
import type { Logger } from '@trendr/logger';
import type { RateLimitInfo } from '@trendr/sources';

/**
 * Spec §10.1 `GET /v1/admin/rate-limits` — "bucket states plus last upstream
 * headers". The token buckets live in Redis (`rl:*`, §7.4); this module keeps
 * the last observed `x-ratelimit-*` headers per source/resource so the admin
 * view can show them without touching an upstream API.
 */

/** Last-header entries outlive an ingest run; 7 d keeps the admin view useful. */
export const RATE_LIMIT_STATE_TTL_SEC = 7 * 86_400;

/** The minimal ioredis slice this needs (unit tests pass a stub). */
export interface RateLimitStateStore {
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
}

/**
 * Best-effort write: a Redis hiccup must never fail the ingest run that
 * observed the headers.
 */
export async function persistRateLimitState(
  store: RateLimitStateStore,
  source: Source,
  info: RateLimitInfo,
  logger?: Logger,
): Promise<void> {
  const key = redisKeys.rateLimitLast(source, info.resource);
  const fields: Record<string, string> = {
    remaining: String(info.remaining),
    observedAt: new Date().toISOString(),
  };
  if (info.resetAt !== null) {
    fields.resetAt = info.resetAt.toISOString();
  }
  try {
    await store.hset(key, fields);
    await store.expire(key, RATE_LIMIT_STATE_TTL_SEC);
  } catch (error) {
    logger?.warn({ err: error, key }, 'rate-limit state not persisted');
  }
}
