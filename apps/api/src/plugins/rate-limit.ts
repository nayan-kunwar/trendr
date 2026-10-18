import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

/** Anonymous tier (spec §10.5): 60 requests per minute per client IP. */
export const ANONYMOUS_MAX = 60;
export const ANONYMOUS_WINDOW_MS = 60_000;

/** Redis namespace for limiter counters (separate from `lb:`, `item:` etc.). */
export const RATE_LIMIT_NAMESPACE = 'ratelimit:';

export interface RateLimitPluginOptions {
  /** Redis-backed counters for multi-replica correctness; omitted → in-memory (tests). */
  redis?: Redis;
  /** Defaults to the anonymous tier; task 3.5 swaps in per-tier values. */
  max?: number;
  timeWindowMs?: number;
  /** Env TRUST_PROXY: only then is `CF-Connecting-IP` trusted (spec §10.5). */
  trustProxy?: boolean;
}

/** Client IP behind Cloudflare when the proxy is trusted, else the socket peer. */
export function clientIp(request: FastifyRequest, trustProxy: boolean): string {
  if (trustProxy) {
    const cf = request.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf.length > 0) {
      return cf;
    }
  }
  return request.ip;
}

/** Spec §10.5: key = API key id ‖ user id ‖ client IP; only the IP tier exists until 3.5. */
export function rateLimitKey(request: FastifyRequest, trustProxy: boolean): string {
  return `ip:${clientIp(request, trustProxy)}`;
}

/**
 * @fastify/rate-limit with the Redis store (spec §10.5): IETF draft headers
 * (`RateLimit-Limit`/`-Remaining`/`-Reset`, `Retry-After`) and fail-open when
 * Redis is unavailable, because the API can still serve from Postgres (§9.3).
 *
 * Awaited by `buildApp`: the limiter works through an onRequest hook, and
 * Fastify applies hooks only to routes registered after them.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitPluginOptions = {},
): Promise<void> {
  const trustProxy = options.trustProxy ?? false;
  await app.register(rateLimit, {
    global: true,
    max: options.max ?? ANONYMOUS_MAX,
    timeWindow: options.timeWindowMs ?? ANONYMOUS_WINDOW_MS,
    keyGenerator: (request) => rateLimitKey(request, trustProxy),
    enableDraftSpec: true,
    skipOnError: true,
    nameSpace: RATE_LIMIT_NAMESPACE,
    ...(options.redis ? { redis: options.redis } : {}),
  });
}
