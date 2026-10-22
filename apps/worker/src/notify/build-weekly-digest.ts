import type { Redis } from 'ioredis';

import { ValidationError, jobId } from '@trendr/core';
import { listDueDigestSubscriptions, type Db } from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { buildDigestContent } from './build-digest.js';
import { weekStartUtc } from './send-digest.js';

/**
 * Spec §13.2 step 1 — build the global digest content once and enqueue one
 * `send-digest` per subscription whose `day_of_week` matches today (UTC).
 */

export interface BuildWeeklyDigestQueue {
  add(
    name: string,
    data: { type: 'send-digest'; subscriptionId: string; weekStart: string },
    options?: { jobId?: string },
  ): Promise<unknown>;
}

export interface BuildWeeklyDigestDeps {
  db: Db;
  redis: Redis;
  digestQueue?: BuildWeeklyDigestQueue;
  now?: () => Date;
  logger?: Logger;
}

export interface BuildWeeklyDigestResult {
  weekStart: string;
  due: number;
  enqueued: number;
}

export async function buildWeeklyDigest(
  deps: BuildWeeklyDigestDeps,
  input: { weekStart?: string },
): Promise<BuildWeeklyDigestResult> {
  const now = deps.now?.() ?? new Date();
  const weekStart = input.weekStart ?? weekStartUtc(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    throw new ValidationError('weekStart must be YYYY-MM-DD');
  }

  await buildDigestContent(deps.db, deps.redis, now);
  const due = await listDueDigestSubscriptions(deps.db, now.getUTCDay());
  let enqueued = 0;
  if (deps.digestQueue !== undefined) {
    for (const subscription of due) {
      await deps.digestQueue.add(
        'send-digest',
        { type: 'send-digest', subscriptionId: subscription.id, weekStart },
        { jobId: jobId.sendDigest(subscription.id, weekStart) },
      );
      enqueued += 1;
    }
  }
  deps.logger?.info({ weekStart, due: due.length, enqueued }, 'weekly digest built');
  return { weekStart, due: due.length, enqueued };
}
