import { UnrecoverableError, type Queue, type Worker } from 'bullmq';

import type { Logger } from '@trendr/logger';

import type { DeadLetterJob } from './queues.js';

/**
 * Spec §7.7 — once a job's last attempt failed (or it failed unrecoverably),
 * park its payload and error in the `dead-letter` queue for inspection.
 */
export function attachDeadLetter(
  worker: Worker,
  deadLetter: Queue<DeadLetterJob>,
  logger?: Logger,
): void {
  worker.on('failed', (job, error) => {
    if (job === undefined) {
      return;
    }
    const isFinal =
      error instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!isFinal) {
      return;
    }
    const entry: DeadLetterJob = {
      originalQueue: job.queueName,
      name: job.name,
      data: job.data,
      jobId: job.id,
      failedReason: error.message,
      stack: error.stack?.slice(0, 4000),
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };
    void deadLetter.add('dead', entry).catch((dlqError: unknown) => {
      logger?.error(
        { err: dlqError, jobId: job.id },
        'could not move job to the dead-letter queue',
      );
    });
  });
}
