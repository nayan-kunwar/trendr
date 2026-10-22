import type { Job, Worker } from 'bullmq';

import type { EmailSender, EmailMessage } from '@trendr/email';

import { emailsSent, jobDuration } from './metrics.js';

/** Spec §14.1: one observation per BullMQ job, by queue/name/status. */
export function instrumentWorker(worker: Worker): void {
  worker.on('completed', (job) => {
    recordJobDuration(worker.name, job, 'completed');
  });
  worker.on('failed', (job) => {
    if (job !== undefined) recordJobDuration(worker.name, job, 'failed');
  });
}

function recordJobDuration(queue: string, job: Job, status: 'completed' | 'failed'): void {
  const started = job.processedOn ?? job.timestamp;
  const finished = job.finishedOn ?? Date.now();
  const seconds = Math.max(0, finished - started) / 1000;
  jobDuration.observe({ queue, name: job.name, status }, seconds);
}

/**
 * Spec §14.1 `trendr_emails_sent_total{template,status}`. The producer sets
 * `tags.kind` to `alert` or `digest`; an unknown tag is bucketed as `unknown`
 * so label cardinality stays bounded.
 */
export function meteredEmailSender(sender: EmailSender): EmailSender {
  return {
    async send(message: EmailMessage): Promise<{ id: string }> {
      const template = message.tags?.kind ?? 'unknown';
      try {
        const result = await sender.send(message);
        emailsSent.inc({ template, status: 'sent' });
        return result;
      } catch (error) {
        emailsSent.inc({ template, status: 'failed' });
        throw error;
      }
    },
  };
}
