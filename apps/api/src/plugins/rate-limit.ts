import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

import { API_RATE_LIMIT_KEY_PREFIX } from '@trendr/core';

import type { AuthenticatedApiKey } from './api-key.js';

/** Anonymous tier (spec §10.5): 60 requests per minute per client IP. */
export const ANONYMOUS_MAX = 60;
export const ANONYMOUS_WINDOW_MS = 60_000;
/** JWT tier (spec §10.5): 300 requests per minute per user. */
export const USER_MAX = 300;
/** Admin tier (spec §10.5): 600 requests per minute. */
export const ADMIN_MAX = 600;

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
 * Spec §10.5: key = API key id ‖ user id ‖ client IP (`apirl:{keyId|userId|ip}`).
 * Keyed, JWT and anonymous traffic therefore never share a counter.
 */
export function rateLimitKey(request: FastifyRequest, trustProxy: boolean): string {
  if (request.apiKey) {
    return `key:${request.apiKey.id}`;
  }
  if (request.authUser) {
    return `user:${request.authUser.id}`;
  }
  return `ip:${clientIp(request, trustProxy)}`;
}

/** Spec §10.5: apiKey → its DB budget, admin → 600, user → 300, else anonymous. */
export function resolveRateLimitMax(request: FastifyRequest, anonymousMax: number): number {
  const apiKey: AuthenticatedApiKey | undefined = request.apiKey;
  if (apiKey !== undefined) {
    return apiKey.rateLimitPerMin;
  }
  if (request.authUser?.role === 'admin') {
    return ADMIN_MAX;
  }
  if (request.authUser !== undefined) {
    return USER_MAX;
  }
  return anonymousMax;
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
