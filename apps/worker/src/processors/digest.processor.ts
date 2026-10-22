import { UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { DigestJobSchema, QUEUE, type DigestJob } from '@trendr/core';
import type { Db } from '@trendr/db';
import type { EmailSender } from '@trendr/email';
import type { Logger } from '@trendr/logger';

import { attachDeadLetter } from '../dlq.js';
import { workerSettings, type Queues } from '../queues.js';
import { buildWeeklyDigest } from '../notify/build-weekly-digest.js';
import { sendDigest } from '../notify/send-digest.js';

/**
 * Spec §3.2/§13.2 — the `digest` queue. `build-weekly-digest` enqueues one
 * `send-digest` per due subscription after caching the week's content;
 * `send-digest` claims `(subscription, week)` before rendering.
 */

export interface DigestProcessorOptions {
  db: Db;
  redis: Redis;
  connection: Redis;
  sender: EmailSender;
  digestQueue?: Queues['digest'];
  webPublicUrl: string;
  apiPublicUrl: string;
  unsubscribeSecret: string;
  unsubscribeMailto?: string;
  deadLetter?: Queues['deadLetter'];
  logger?: Logger;
  now?: () => Date;
  concurrency?: number;
  settings?: NonNullable<WorkerOptions['settings']>;
}

export interface DigestResult {
  type: DigestJob['type'];
  processed: number;
}

export function createDigestWorker(
  options: DigestProcessorOptions,
): Worker<DigestJob, DigestResult> {
  const worker = new Worker<DigestJob, DigestResult>(
    QUEUE.digest,
    async (job) => {
      const parsed = DigestJobSchema.safeParse(job.data);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => issue.path.join('.') || issue.message)
          .join(', ');
        throw new UnrecoverableError(`invalid digest job payload: ${problems}`);
      }

      if (parsed.data.type === 'build-weekly-digest') {
        const result = await buildWeeklyDigest(
          {
            db: options.db,
            redis: options.redis,
            ...(options.digestQueue === undefined ? {} : { digestQueue: options.digestQueue }),
            ...(options.logger === undefined ? {} : { logger: options.logger }),
            ...(options.now === undefined ? {} : { now: options.now }),
          },
          parsed.data.weekStart === undefined ? {} : { weekStart: parsed.data.weekStart },
        );
        return { type: parsed.data.type, processed: result.enqueued };
      }

      const result = await sendDigest(
        {
          db: options.db,
          redis: options.redis,
          sender: options.sender,
          webPublicUrl: options.webPublicUrl,
          apiPublicUrl: options.apiPublicUrl,
          unsubscribeSecret: options.unsubscribeSecret,
          ...(options.unsubscribeMailto === undefined
            ? {}
            : { unsubscribeMailto: options.unsubscribeMailto }),
          ...(options.logger === undefined ? {} : { logger: options.logger }),
          ...(options.now === undefined ? {} : { now: options.now }),
        },
        {
          subscriptionId: parsed.data.subscriptionId,
          weekStart: parsed.data.weekStart,
        },
      );
      return { type: parsed.data.type, processed: result.status === 'sent' ? 1 : 0 };
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 5,
      limiter: { max: 2, duration: 1_000 },
      settings: options.settings ?? workerSettings,
    },
  );

  worker.on('error', (error: Error) => {
    options.logger?.error({ err: error, queue: QUEUE.digest }, 'digest worker error');
  });
  if (options.deadLetter !== undefined) {
    attachDeadLetter(worker, options.deadLetter, options.logger);
  }
  return worker;
}
