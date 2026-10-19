import { Queue, type Job, type JobsOptions, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';

import {
  QUEUE,
  SOURCES,
  WINDOWS,
  backoffDelay,
  jobId,
  UpstreamError,
  type IngestJob,
  type NotifyJob,
  type ScoringJob,
  type Source,
  type Window,
} from '@trendr/core';

/**
 * Spec §7.5/§5.2 — BullMQ plumbing: the producer connection, default job
 * options (retries with the custom backoff, age/count retention), the queue
 * registry, the deterministic scoring enqueue helper (jobId dedupe) and the
 * dead-letter payload of §7.7.
 */

export const defaultJobOpts: JobsOptions = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/**
 * Spec §7.5 — custom backoff: when upstream asked us to wait (`429` /
 * quota-403 surfaced as `UpstreamError.retryAfterMs`), wait exactly that long
 * plus jitter; everything else uses full jitter between 5 s and 30 minutes.
 */
export const workerSettings: NonNullable<WorkerOptions['settings']> = {
  backoffStrategy: (attemptsMade, _type, err) => {
    if (err instanceof UpstreamError && err.retryAfterMs) {
      return err.retryAfterMs + Math.floor(Math.random() * 5_000);
    }
    return backoffDelay(attemptsMade, 5_000, 30 * 60_000);
  },
};

/** BullMQ requires `maxRetriesPerRequest: null` (spec §3); ioredis reconnects on its own. */
export function createWorkerConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

/** Spec §7.7 — payload parked in the `dead-letter` queue after the last failed attempt. */
export interface DeadLetterJob {
  originalQueue: string;
  name: string;
  data: unknown;
  jobId: string | undefined;
  failedReason: string;
  stack: string | undefined;
  attemptsMade: number;
  failedAt: string;
}

export interface Queues {
  ingest: Record<Source, Queue<IngestJob>>;
  scoring: Queue<ScoringJob, ScoringResult>;
  notify: Queue<NotifyJob>;
  deadLetter: Queue<DeadLetterJob>;
}

/** What the `scoring` processor returns (`job.returnvalue`). */
export interface ScoringResult {
  source: Source;
  windows: Window[];
}

export function createQueues(connection: Redis): Queues {
  const options = { connection, defaultJobOptions: defaultJobOpts };
  const ingest = {} as Record<Source, Queue<IngestJob>>;
  for (const source of SOURCES) {
    ingest[source] = new Queue<IngestJob>(QUEUE.ingest[source], options);
  }
  return {
    ingest,
    scoring: new Queue<ScoringJob, ScoringResult>(QUEUE.scoring, options),
    notify: new Queue<NotifyJob>(QUEUE.notify, options),
    deadLetter: new Queue<DeadLetterJob>(QUEUE.deadLetter, options),
  };
}

export async function closeQueues(queues: Queues): Promise<void> {
  await Promise.all([
    ...Object.values(queues.ingest).map((queue) => queue.close()),
    queues.scoring.close(),
    queues.notify.close(),
    queues.deadLetter.close(),
  ]);
}

/**
 * 'YYYY-MM-DDTHH-mm' (UTC), floored to ten minutes — the scoring job-id slot of
 * §5.2: runs requested inside one slot dedupe into a single BullMQ job.
 */
export function scoringSlot(at: Date): string {
  const minutes = Math.floor(at.getUTCMinutes() / 10) * 10;
  const date = at.toISOString().slice(0, 10);
  const hours = String(at.getUTCHours()).padStart(2, '0');
  return `${date}T${hours}-${String(minutes).padStart(2, '0')}`;
}

export interface EnqueueScoringInput {
  source: Source;
  windows?: readonly Window[];
  trigger: ScoringJob['trigger'];
  /** Overrides the derived ten-minute slot (idempotency checks, tests). */
  slot?: string;
  delayMs?: number;
}

/** Enqueue `compute-scores` with the deterministic §5.2 jobId (same slot ⇒ same job). */
export async function enqueueScoringRun(
  queue: Queue<ScoringJob, ScoringResult>,
  input: EnqueueScoringInput,
): Promise<Job<ScoringJob, ScoringResult>> {
  const data: ScoringJob = {
    source: input.source,
    windows: [...(input.windows ?? WINDOWS)],
    trigger: input.trigger,
  };
  return queue.add('compute-scores', data, {
    ...defaultJobOpts,
    ...(input.delayMs === undefined ? {} : { delay: input.delayMs }),
    jobId: jobId.scoring(input.source, input.slot ?? scoringSlot(new Date())),
  });
}
