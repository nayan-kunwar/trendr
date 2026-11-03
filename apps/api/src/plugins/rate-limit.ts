import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';
import { isIP } from 'node:net';

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
  /** Env TRUST_PROXY: trust the platform's `X-Forwarded-For` chain (spec §10.5). */
  trustProxy?: boolean;
  /** Env TRUST_CF_CONNECTING_IP: only nginx overwrites this header (M-12). */
  trustCfConnectingIp?: boolean;
}

/**
 * Client IP behind Cloudflare when the proxy is trusted, else the socket peer.
 *
 * H-1: the header is caller-controlled until a trusted proxy overwrites it, so
 * only a bare IP address is accepted. Garbage (including a comma-separated
 * chain or `host:port`) falls back to `request.ip`, which keeps rate-limit
 * keys stable and prevents invalid `inet` writes.
 */
export function clientIp(
  request: FastifyRequest,
  trustProxy: boolean,
  trustCfConnectingIp = false,
): string {
  // M-12: `CF-Connecting-IP` is only authentic when a trusted proxy overwrites
  // it (the VPS nginx). On Render, TRUST_PROXY covers `X-Forwarded-For` only.
  if (trustProxy && trustCfConnectingIp) {
    const cf = request.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && isIP(cf) !== 0) {
      return cf;
    }
  }
  return request.ip;
}

/**
 * Spec §10.5: key = API key id ‖ user id ‖ client IP (`apirl:{keyId|userId|ip}`).
 * Keyed, JWT and anonymous traffic therefore never share a counter.
 */
export function rateLimitKey(
  request: FastifyRequest,
  trustProxy: boolean,
  trustCfConnectingIp = false,
): string {
  if (request.apiKey) {
    return `key:${request.apiKey.id}`;
  }
  if (request.authUser) {
    return `user:${request.authUser.id}`;
  }
  return `ip:${clientIp(request, trustProxy, trustCfConnectingIp)}`;
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
 * L-11: observe the rate-limit store's command failures. `skipOnError` keeps
 * the API serving (spec §9.3), but the failure must be countable and logged.
 *
 * `@fastify/rate-limit` installs two Lua commands on the client and calls them
 * with a node-style callback; the proxy wraps that callback so the plugin's
 * behaviour is untouched. Every other property is forwarded (and methods keep
 * their `this` binding, which ioredis relies on).
 */
export function observeRateLimitRedis<T extends object>(
  redis: T,
  onError: (error: unknown) => void,
): T {
  return new Proxy(redis, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') {
        return value;
      }
      const name = String(property);
      if (name !== 'rateLimit' && name !== 'rateLimitRead') {
        return value.bind(target) as unknown;
      }
      return (...args: unknown[]): unknown => {
        const callback = args.at(-1);
        if (typeof callback !== 'function') {
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        }
        const wrapped = (error: unknown, result: unknown): void => {
          if (error) {
            onError(error);
          }
          (callback as (innerError: unknown, innerResult: unknown) => void)(error, result);
        };
        return (value as (...inner: unknown[]) => unknown).apply(target, [
          ...args.slice(0, -1),
          wrapped,
        ]);
      };
    },
  });
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
  const trustCfConnectingIp = options.trustCfConnectingIp ?? false;
  const anonymousMax = options.max ?? ANONYMOUS_MAX;
  const redis =
    options.redis === undefined
      ? undefined
      : observeRateLimitRedis(options.redis, (error) => {
          app.log.error({ err: error }, 'rate-limit store failed; failing open (spec §9.3)');
          if (app.hasDecorator('observeRateLimitDegraded')) {
            app.observeRateLimitDegraded();
          }
        });
  await app.register(rateLimit, {
    global: true,
    max: (request) => resolveRateLimitMax(request, anonymousMax),
    timeWindow: options.timeWindowMs ?? ANONYMOUS_WINDOW_MS,
    keyGenerator: (request) => rateLimitKey(request, trustProxy, trustCfConnectingIp),
    enableDraftSpec: true,
    skipOnError: true,
    // Spec §9.1: `apirl:{keyId|ip}` is the inbound API rate-limit key space.
    nameSpace: API_RATE_LIMIT_KEY_PREFIX,
    ...(redis ? { redis } : {}),
  });
}
