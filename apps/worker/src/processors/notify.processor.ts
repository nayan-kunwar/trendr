import { UnrecoverableError, Worker, type WorkerOptions } from 'bullmq';
import type { Redis } from 'ioredis';

import { NotifyJobSchema, QUEUE, type NotifyJob } from '@trendr/core';
import type { Db } from '@trendr/db';
import type { EmailSender } from '@trendr/email';
import type { Logger } from '@trendr/logger';

import { attachDeadLetter } from '../dlq.js';
import { workerSettings, type Queues } from '../queues.js';
import { evaluateAlerts } from '../notify/evaluate-alerts.js';
import { sendAlertEmails } from '../notify/send-alert-email.js';

/**
 * Spec §3.2/§13 — the `notify` queue: `evaluate-alerts` inserts deduplicated
 * events, `send-alert-email` renders and delivers through the shared
 * provider-neutral sender. Worker concurrency is 5 and the §13.3 limiter keeps
 * provider throughput at two messages per second.
 */

export interface NotifyProcessorOptions {
  db: Db;
  redis: Redis;
  connection: Redis;
  sender: EmailSender;
  notifyQueue?: Queues['notify'];
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

export interface NotifyResult {
  type: NotifyJob['type'];
  processed: number;
}

export function createNotifyWorker(
  options: NotifyProcessorOptions,
): Worker<NotifyJob, NotifyResult> {
  const worker = new Worker<NotifyJob, NotifyResult>(
    QUEUE.notify,
    async (job) => {
      const parsed = NotifyJobSchema.safeParse(job.data);
      if (!parsed.success) {
        const problems = parsed.error.issues
          .map((issue) => issue.path.join('.') || issue.message)
          .join(', ');
        throw new UnrecoverableError(`invalid notify job payload: ${problems}`);
      }

      switch (parsed.data.type) {
        case 'evaluate-alerts': {
          const result = await evaluateAlerts(
            {
              db: options.db,
              redis: options.redis,
              ...(options.notifyQueue === undefined ? {} : { notifyQueue: options.notifyQueue }),
              ...(options.logger === undefined ? {} : { logger: options.logger }),
              ...(options.now === undefined ? {} : { now: options.now }),
            },
            parsed.data,
          );
          return { type: parsed.data.type, processed: result.inserted };
        }
        case 'send-alert-email': {
          const ids = parsed.data.alertEventIds ?? [parsed.data.alertEventId];
          const result = await sendAlertEmails(
            {
              db: options.db,
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
            ids,
          );
          return { type: parsed.data.type, processed: result.sent };
        }
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency ?? 5,
      limiter: { max: 2, duration: 1_000 },
      settings: options.settings ?? workerSettings,
    },
  );

  worker.on('error', (error: Error) => {
    options.logger?.error({ err: error, queue: QUEUE.notify }, 'notify worker error');
  });
  if (options.deadLetter !== undefined) {
    attachDeadLetter(worker, options.deadLetter, options.logger);
  }
  return worker;
}
