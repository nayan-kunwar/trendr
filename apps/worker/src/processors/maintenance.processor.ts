import { UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { MaintenanceJobSchema, QUEUE, type MaintenanceJob } from '@trendr/core';
import type { Db } from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { attachDeadLetter } from '../dlq.js';
import { runRetierItems, type HotMaxBySource, type RetierSummary } from '../ingestion/tiering.js';
import { workerSettings, type Queues } from '../queues.js';

/**
 * Spec §3.2/§7.8 — the `maintenance` queue processor (the `scoring` role
 * hosts it). Task 4.5 implements `retier-items`; the remaining §7.10 jobs
 * (`create-partitions`, `retention`, `rollup-daily`, `cleanup-tokens`) arrive
 * with their own tasks and currently fail unrecoverably instead of silently
 * doing nothing.
 */

export interface MaintenanceProcessorOptions {
  db: Db;
  /** BullMQ connection (`maxRetriesPerRequest: null`), shared with the producers. */
  connection: Redis;
  /** When present, finally-failed jobs are parked per §7.7. */
  deadLetter?: Queues['deadLetter'];
  logger?: Logger;
  /** `TRACKED_HOT_MAX_*` (spec §7.8); omitted ⇒ no cap. */
  hotMaxBySource?: HotMaxBySource;
  /** Clock override (tests). */
  now?: () => Date;
  concurrency?: number;
  settings?: NonNullable<WorkerOptions['settings']>;
}

export interface MaintenanceResult {
  type: MaintenanceJob['type'];
  /** Present for `retier-items`. */
  retier?: RetierSummary;
}

export function createMaintenanceWorker(
  options: MaintenanceProcessorOptions,
): Worker<MaintenanceJob, MaintenanceResult> {
  const worker = new Worker<MaintenanceJob, MaintenanceResult>(
    QUEUE.maintenance,
    async (job) => {
      const parsed = MaintenanceJobSchema.safeParse(job.data);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => issue.path.join('.') || issue.message)
          .join(', ');
        throw new UnrecoverableError(`invalid maintenance job payload: ${problems}`);
      }

      switch (parsed.data.type) {
        case 'retier-items': {
          const retier = await runRetierItems({
            db: options.db,
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            ...(options.hotMaxBySource === undefined
              ? {}
              : { hotMaxBySource: options.hotMaxBySource }),
            ...(options.now === undefined ? {} : { now: options.now }),
          });
          return { type: parsed.data.type, retier };
        }
        default:
          throw new UnrecoverableError(
            `maintenance job "${parsed.data.type}" is not implemented yet`,
          );
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 1,
      settings: options.settings ?? workerSettings,
    },
  );

  worker.on('error', (error: Error) => {
    options.logger?.error({ err: error, queue: QUEUE.maintenance }, 'maintenance worker error');
  });
  if (options.deadLetter !== undefined) {
    attachDeadLetter(worker, options.deadLetter, options.logger);
  }
  return worker;
}
