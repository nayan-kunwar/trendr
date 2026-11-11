import type { FastifyInstance } from 'fastify';

import { bumpMemoryCounter, incrementWithTtl } from '../plugins/counters.js';

/**
 * L-1 fixed-window counters shared by the auth and OAuth routes. Redis is the
 * primary store; the bounded process-local map keeps a Redis outage from
 * turning sign-in into an unlimited endpoint.
 */

const memoryAuthCounters = new Map<string, { count: number; resetAt: number }>();

export async function allowCounter(
  app: FastifyInstance,
  key: string,
  windowSeconds: number,
  max: number,
): Promise<boolean> {
  if (max <= 0) return true;

  if (app.hasDecorator('redis')) {
    const count = await incrementWithTtl(app.redis, key, windowSeconds);
    if (count !== null) return count <= max;
    // Redis is a best-effort limiter; fall through to the bounded local map.
  }

  return bumpMemoryCounter(memoryAuthCounters, key, Date.now(), windowSeconds * 1_000, max);
}
