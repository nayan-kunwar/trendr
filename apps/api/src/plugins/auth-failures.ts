import type { FastifyInstance, FastifyRequest } from 'fastify';

import { redisKeys } from '@trendr/core';

import { bumpMemoryCounter, incrementWithTtl, type CounterEntry } from './counters.js';
import { clientIp } from './rate-limit.js';

/**
 * Failed-credential guard for the API-key and JWT authentication hooks.
 *
 * Those hooks are instance-level `onRequest` handlers, so they run before the
 * route-level `@fastify/rate-limit` handler. Without this guard an unauthenticated
 * caller can send unlimited random `X-API-Key` values (each causing a database
 * lookup and a Redis write) or bearer tokens (each causing a signature check).
 * The guard counts only rejected credentials, so successful requests keep their
 * normal anonymous/user/admin/API-key tier.
 */

export const AUTH_FAILURE_MAX = 20;
export const AUTH_FAILURE_WINDOW_SECONDS = 60;

const memoryFailures = new Map<string, CounterEntry>();

export type AuthFailureKind = 'api-key' | 'bearer';

export interface AuthFailureOptions {
  trustProxy: boolean;
  trustCfConnectingIp: boolean;
  /** Failures allowed per IP per window; defaults to AUTH_FAILURE_MAX. */
  max?: number | undefined;
  /** Window in seconds; defaults to AUTH_FAILURE_WINDOW_SECONDS. */
  windowSeconds?: number | undefined;
}

function failureKey(
  request: FastifyRequest,
  kind: AuthFailureKind,
  options: AuthFailureOptions,
): string {
  return redisKeys.authFailureBucket(
    kind,
    clientIp(request, options.trustProxy, options.trustCfConnectingIp),
  );
}

function memoryCount(key: string, now: number): number {
  const entry = memoryFailures.get(key);
  return entry !== undefined && entry.resetAt > now ? entry.count : 0;
}

/** Read-only check; call before doing the expensive credential verification. */
export async function authFailureBudgetExhausted(
  app: FastifyInstance,
  request: FastifyRequest,
  kind: AuthFailureKind,
  options: AuthFailureOptions,
): Promise<boolean> {
  const max = options.max ?? AUTH_FAILURE_MAX;
  if (max <= 0) return false;
  const key = failureKey(request, kind, options);

  if (app.hasDecorator('redis')) {
    try {
      const raw = await app.redis.get(key);
      const count = raw === null ? 0 : Number(raw);
      // A missing key or a failed parse means "within budget". Do not consult
      // the memory map here: Redis is authoritative while it is reachable.
      return Number.isFinite(count) && count >= max;
    } catch {
      // Fall through to the bounded local map.
    }
  }

  return memoryCount(key, Date.now()) >= max;
}

/** Count one rejected credential; never throws, so the 401 path stays intact. */
export async function noteAuthFailure(
  app: FastifyInstance,
  request: FastifyRequest,
  kind: AuthFailureKind,
  options: AuthFailureOptions,
): Promise<void> {
  const max = options.max ?? AUTH_FAILURE_MAX;
  if (max <= 0) return;
  const key = failureKey(request, kind, options);
  const windowSeconds = options.windowSeconds ?? AUTH_FAILURE_WINDOW_SECONDS;

  if (app.hasDecorator('redis')) {
    const count = await incrementWithTtl(app.redis, key, windowSeconds);
    if (count !== null) return;
  }

  bumpMemoryCounter(
    memoryFailures,
    key,
    Date.now(),
    Math.max(1, windowSeconds) * 1_000,
    Number.MAX_SAFE_INTEGER,
  );
}

/** Test/tooling hook: clear the process-local fallback between cases. */
export function clearAuthFailureMemory(): void {
  memoryFailures.clear();
}
