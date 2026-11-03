import { UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

import { QUEUE, ScoringJobSchema, jobId, type ScoringJob } from '@trendr/core';
import type { Db } from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { attachDeadLetter } from '../dlq.js';
import { scoringSlot, workerSettings, type Queues, type ScoringResult } from '../queues.js';
import { runScoring, type NotifyQueue, type ScoringDeps } from './run-scoring.js';

export interface ScoringProcessorOptions {
  db: Db;
  redis: Redis;
  /** BullMQ connection (`maxRetriesPerRequest: null`), shared with the producers. */
  connection: Redis;
  /** Where the `evaluate-alerts` fan-out lands; omit to skip it. */
  notifyQueue?: NotifyQueue;
  /** When present, finally-failed jobs are parked per §7.7. */
  deadLetter?: Queues['deadLetter'];
  logger?: Logger;
  /** Clock override (tests); scoring floors it to the hour (§8.1). */
  now?: () => Date;
  concurrency?: number;
}

/**
 * Spec §3.3/§8.4 — the `scoring` queue processor: validate the `compute-scores`
 * payload, run `runScoring` (which owns the per-source Redis lock) and return
 * `{ source, windows }`. Invalid payloads throw `UnrecoverableError` so BullMQ
 * skips the remaining attempts; other errors retry with the custom backoff.
 */
export function createScoringWorker(
  options: ScoringProcessorOptions,
): Worker<ScoringJob, ScoringResult> {
  const worker = new Worker<ScoringJob, ScoringResult>(
    QUEUE.scoring,
    async (job) => {
      const parsed = ScoringJobSchema.safeParse(job.data);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => issue.path.join('.') || issue.message)
          .join(', ');
        throw new UnrecoverableError(`invalid scoring job payload: ${problems}`);
      }
      const deps: ScoringDeps = {
        db: options.db,
        redis: options.redis,
        jobId: job.id ?? jobId.scoring(parsed.data.source, scoringSlot(new Date())),
        now: options.now ?? (() => new Date()),
        ...(options.notifyQueue === undefined ? {} : { notifyQueue: options.notifyQueue }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      };
      const outcome = await runScoring(parsed.data.source, parsed.data.windows, deps);
      return {
        source: parsed.data.source,
        windows: parsed.data.windows,
        status: outcome.status,
        ...(outcome.status === 'scored' ? { runId: outcome.runId.toString() } : {}),
      };
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
      settings: workerSettings,
    },
  );

  worker.on('error', (error: Error) => {
    options.logger?.error({ err: error, queue: QUEUE.scoring }, 'scoring worker error');
  });
  if (options.deadLetter !== undefined) {
    attachDeadLetter(worker, options.deadLetter, options.logger);
  }
  return worker;
}
