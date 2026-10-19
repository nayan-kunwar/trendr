import fp from 'fastify-plugin';
import type { Redis } from 'ioredis';

import {
  UnauthorizedError,
  apiKeyHashesMatch,
  hashApiKey,
  parseApiKey,
  redisKeys,
} from '@trendr/core';
import { findApiKeyByPrefix, touchApiKeyLastUsed } from '@trendr/db';

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
}

/** Spec §10.5: `last_used_at` is written at most once per minute. */
export const API_KEY_DEBOUNCE_MS = 60_000;

/**
 * `X-API-Key` authentication (spec §10.5, §15): shape check, unique-prefix
 * lookup, constant-time HMAC-SHA256 compare, revocation/expiry checks and the
 * debounced `last_used_at` touch. An invalid key fails with 401 before any
 * route handler (and before the rate limiter) runs; requests without the
 * header stay anonymous.
 */
export const registerApiKey = fp<ApiKeyPluginOptions>(
  (app, { pepper, redis, debounceMs = API_KEY_DEBOUNCE_MS }) => {
    const ttlSeconds = Math.max(1, Math.ceil(debounceMs / 1000));
    const memoryWindow = new Map<string, number>();

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
      const raw = Array.isArray(header) ? header[0] : header;
      if (typeof raw !== 'string' || raw.length === 0) {
        throw new UnauthorizedError('invalid API key');
      }
      const parsed = parseApiKey(raw);
      if (parsed === null) {
        throw new UnauthorizedError('invalid API key');
      }

      const record = await findApiKeyByPrefix(app.db, parsed.prefix);
      if (record === null) {
        throw new UnauthorizedError('invalid API key');
      }
      if (record.revokedAt !== null) {
        throw new UnauthorizedError('API key revoked');
      }
      if (record.expiresAt !== null && record.expiresAt.getTime() <= Date.now()) {
        throw new UnauthorizedError('API key expired');
      }
      if (!apiKeyHashesMatch(record.keyHash, hashApiKey(pepper, raw))) {
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
