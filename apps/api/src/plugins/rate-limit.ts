import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { API_RATE_LIMIT_KEY_PREFIX } from '@trendr/core';

import type { AuthenticatedApiKey } from './api-key.js';

/** Anonymous tier (spec §10.5): 60 requests per minute per client IP. */
export const ANONYMOUS_MAX = 60;
export const ANONYMOUS_WINDOW_MS = 60_000;
/** JWT tier (spec §10.5); wired when token verification lands with the auth routes. */
export const USER_MAX = 300;

export interface RateLimitPluginOptions {
  /** Redis-backed counters for multi-replica correctness; omitted → in-memory (tests). */
  redis?: Redis;
  /** Anonymous-tier budget (spec §10.5); authenticated keys use their own DB budget. */
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

/**
 * Spec §10.5: key = API key id ‖ user id ‖ client IP (`apirl:{keyId|ip}`).
 * Keyed and anonymous traffic therefore never share a counter. The JWT `user`
 * part arrives with token verification.
 */
export function rateLimitKey(request: FastifyRequest, trustProxy: boolean): string {
  if (request.apiKey) {
    return `key:${request.apiKey.id}`;
  }
  return `ip:${clientIp(request, trustProxy)}`;
}

/** Spec §10.5: the apiKey tier uses `api_keys.rate_limit_per_min` (default 120). */
export function resolveRateLimitMax(request: FastifyRequest, anonymousMax: number): number {
  const apiKey: AuthenticatedApiKey | undefined = request.apiKey;
  return apiKey?.rateLimitPerMin ?? anonymousMax;
}

/**
 * @fastify/rate-limit with the Redis store (spec §10.5): IETF draft headers
 * (`RateLimit-Limit`/`-Remaining`/`-Reset`, `Retry-After`) and fail-open when
 * Redis is unavailable, because the API can still serve from Postgres (§9.3).
 *
 * Awaited by `buildApp`: the limiter works through an onRequest hook, and
 * Fastify applies hooks only to routes registered after them. Register it
 * after the api-key plugin so per-key budgets are visible here.
 */
export async function registerRateLimit(
  app: FastifyInstance,
  options: RateLimitPluginOptions = {},
): Promise<void> {
  const trustProxy = options.trustProxy ?? false;
  const anonymousMax = options.max ?? ANONYMOUS_MAX;
  await app.register(rateLimit, {
    global: true,
    max: (request) => resolveRateLimitMax(request, anonymousMax),
    timeWindow: options.timeWindowMs ?? ANONYMOUS_WINDOW_MS,
    keyGenerator: (request) => rateLimitKey(request, trustProxy),
    enableDraftSpec: true,
    skipOnError: true,
    // Spec §9.1: `apirl:{keyId|ip}` is the inbound API rate-limit key space.
    nameSpace: API_RATE_LIMIT_KEY_PREFIX,
    ...(options.redis ? { redis: options.redis } : {}),
  });
}
