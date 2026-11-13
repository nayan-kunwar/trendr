import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import {
  RateLimitedError,
  UnauthorizedError,
  apiKeyHashesMatch,
  hashApiKey,
  parseApiKey,
  redisKeys,
} from '@trendr/core';
import { findApiKeyByPrefix, touchApiKeyLastUsed, type ApiKeyRecord } from '@trendr/db';

import { authFailureBudgetExhausted, noteAuthFailure } from './auth-failures.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Present when `X-API-Key` authenticated the request (spec §10.5). */
    apiKey?: AuthenticatedApiKey;
  }
}

/** The `apiKey` tier identity attached to authenticated requests. */
export interface AuthenticatedApiKey {
  id: string;
  userId: string;
  /** `read` | `admin` (spec §15). */
  scopes: string[];
  /** Per-key budget for the apiKey rate-limit tier (spec §10.5). */
  rateLimitPerMin: number;
}

export interface ApiKeyPluginOptions {
  /** API_KEY_PEPPER (spec §15) — hashes keys and never leaves the process. */
  pepper: string;
  /** Debounce store for `last_used_at`; omitted → per-process in-memory window. */
  redis?: Redis;
  /** Debounce window; default 60 s (spec §10.5). */
  debounceMs?: number;
  /** Trusted-proxy flags for the failed-credential guard. */
  trustProxy?: boolean;
  trustCfConnectingIp?: boolean;
  /** Rejected keys allowed per IP per window; 0 disables the guard (tests). */
  failureMax?: number;
  /** Failed-credential window in seconds. */
  failureWindowSeconds?: number;
}

/** Spec §10.5: `last_used_at` is written at most once per minute. */
export const API_KEY_DEBOUNCE_MS = 60_000;

/** M-2: how long a prefix lookup may be served from Redis before the DB. */
export const API_KEY_LOOKUP_TTL_SECONDS = 60;

/**
 * M-2: the cache payload is our own row, but it crosses a process boundary
 * (Redis), so it is validated like any external input. `keyHash` is base64 and
 * the timestamps are ISO strings.
 */
const CachedApiKeySchema = z.object({
  id: z.string(),
  userId: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  rateLimitPerMin: z.number(),
  keyHash: z.string(),
  revokedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

function toCached(record: ApiKeyRecord): string {
  return JSON.stringify({
    id: record.id,
    userId: record.userId,
    prefix: record.prefix,
    scopes: record.scopes,
    rateLimitPerMin: record.rateLimitPerMin,
    keyHash: record.keyHash.toString('base64'),
    revokedAt: record.revokedAt?.toISOString() ?? null,
    expiresAt: record.expiresAt?.toISOString() ?? null,
  });
}

function fromCached(raw: string): ApiKeyRecord | undefined {
  try {
    const parsed = CachedApiKeySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return undefined;
    const row = parsed.data;
    return {
      id: row.id,
      userId: row.userId,
      prefix: row.prefix,
      scopes: row.scopes,
      rateLimitPerMin: row.rateLimitPerMin,
      keyHash: Buffer.from(row.keyHash, 'base64'),
      revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
    };
  } catch {
    return undefined;
  }
}

/** Negative-cache marker: no `api_keys` row has this prefix. */
const API_KEY_CACHE_MISS = '0';

/**
 * `X-API-Key` authentication (spec §10.5, §15): shape check, unique-prefix
 * lookup, constant-time HMAC-SHA256 compare, revocation/expiry checks and the
 * debounced `last_used_at` touch. An invalid key fails with 401 before any
 * route handler (and before the rate limiter) runs; requests without the
 * header stay anonymous.
 */
export const registerApiKey = fp<ApiKeyPluginOptions>(
  (
    app,
    {
      pepper,
      redis,
      debounceMs = API_KEY_DEBOUNCE_MS,
      trustProxy = false,
      trustCfConnectingIp = false,
      failureMax,
      failureWindowSeconds,
    },
  ) => {
    const ttlSeconds = Math.max(1, Math.ceil(debounceMs / 1000));
    const memoryWindow = new Map<string, number>();
    const failureOptions = {
      trustProxy,
      trustCfConnectingIp,
      ...(failureMax === undefined ? {} : { max: failureMax }),
      ...(failureWindowSeconds === undefined ? {} : { windowSeconds: failureWindowSeconds }),
    } as const;

    /**
     * First caller within the window wins; used to skip redundant
     * `last_used_at` writes. Redis NX when available, per-process otherwise.
     */
    const claimTouch = async (id: string): Promise<boolean> => {
      if (redis) {
        const claimed = await redis.set(redisKeys.apiKeyLastUsed(id), '1', 'EX', ttlSeconds, 'NX');
        return claimed === 'OK';
      }
      const now = Date.now();
      const until = memoryWindow.get(id);
      if (until !== undefined && until > now) {
        return false;
      }
      memoryWindow.set(id, now + debounceMs);
      return true;
    };

    app.addHook('onRequest', async (request) => {
      const header = request.headers['x-api-key'];
      if (header === undefined) {
        return;
      }

      // This hook runs before the route-level @fastify/rate-limit handler, so
      // rejected keys need their own pre-work budget. Check it before parsing,
      // the Redis lookup, or the database query.
      if (await authFailureBudgetExhausted(app, request, 'api-key', failureOptions)) {
        throw new RateLimitedError('too many invalid API keys; try again in a minute');
      }

      const raw = Array.isArray(header) ? header[0] : header;
      if (typeof raw !== 'string' || raw.length === 0) {
        await noteAuthFailure(app, request, 'api-key', failureOptions);
        throw new UnauthorizedError('invalid API key');
      }
      const parsed = parseApiKey(raw);
      if (parsed === null) {
        await noteAuthFailure(app, request, 'api-key', failureOptions);
        throw new UnauthorizedError('invalid API key');
      }

      // M-2: a per-request DB lookup made a flood of distinct prefixes a
      // database amplifier. The row (or the miss) is cached for 60 s; revoke
      // deletes the entry explicitly.
      const cacheKey = redisKeys.apiKeyLookup(parsed.prefix);
      let record: ApiKeyRecord | null | undefined;
      if (redis !== undefined) {
        try {
          const cached = await redis.get(cacheKey);
          if (cached === API_KEY_CACHE_MISS) {
            record = null;
          } else if (cached !== null) {
            record = fromCached(cached) ?? undefined;
          }
        } catch (error) {
          app.log.warn({ err: error }, 'api-key lookup cache read failed');
        }
      }
      if (record === undefined) {
        record = await findApiKeyByPrefix(app.db, parsed.prefix);
        if (redis !== undefined) {
          redis
            .set(
              cacheKey,
              record === null ? API_KEY_CACHE_MISS : toCached(record),
              'EX',
              API_KEY_LOOKUP_TTL_SECONDS,
            )
            .catch((error: unknown) => {
              app.log.warn({ err: error }, 'api-key lookup cache write failed');
            });
        }
      }
      if (record === null) {
        await noteAuthFailure(app, request, 'api-key', failureOptions);
        throw new UnauthorizedError('invalid API key');
      }
      if (record.revokedAt !== null) {
        await noteAuthFailure(app, request, 'api-key', failureOptions);
        throw new UnauthorizedError('API key revoked');
      }
      if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
        await noteAuthFailure(app, request, 'api-key', failureOptions);
        throw new UnauthorizedError('API key expired');
      }
      if (!apiKeyHashesMatch(record.keyHash, hashApiKey(pepper, raw))) {
        await noteAuthFailure(app, request, 'api-key', failureOptions);
        throw new UnauthorizedError('invalid API key');
      }

      request.apiKey = {
        id: record.id,
        userId: record.userId,
        scopes: record.scopes,
        rateLimitPerMin: record.rateLimitPerMin,
      };

      // Debounced at most once per minute (spec §10.5); never fails the request.
      try {
        if (await claimTouch(record.id)) {
          await touchApiKeyLastUsed(app.db, record.id, new Date());
        }
      } catch (error) {
        request.log.warn({ err: error }, 'api key last_used_at update skipped');
      }
    });
  },
  { name: 'api-key' },
);
