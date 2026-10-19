import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import {
  DEFAULT_JOB_OPTS,
  QUEUE,
  SOURCES,
  type DeadLetterJob,
  type DigestJob,
  type IngestJob,
  type MaintenanceJob,
  type NotifyJob,
  type ScoringJob,
  type Source,
} from '@trendr/core';

/**
 * Spec §10.1 admin endpoints + §7.7 DLQ replay: the API is a producer for every
 * §5.2 queue. It never processes jobs (that is the worker's job), so the
 * connection only needs producer semantics; callers own it and `close()`
 * releases the queues.
 */

export interface ApiQueues {
  ingest: Record<Source, Queue<IngestJob>>;
  scoring: Queue<ScoringJob>;
  notify: Queue<NotifyJob>;
  digest: Queue<DigestJob>;
  maintenance: Queue<MaintenanceJob>;
  deadLetter: Queue<DeadLetterJob>;
  /** Resolve a §5.2 queue name for DLQ replay; undefined for foreign names. */
  byName(name: string): Queue | undefined;
  /** Every queue (for `/v1/admin/queues`). */
  all(): Queue[];
  close(): Promise<void>;
}

export function createApiQueues(connection: Redis): ApiQueues {
  const options = { connection, defaultJobOptions: DEFAULT_JOB_OPTS };
  const ingest = Object.fromEntries(
    SOURCES.map((source) => [source, new Queue<IngestJob>(QUEUE.ingest[source], options)]),
  ) as Record<Source, Queue<IngestJob>>;
  const scoring = new Queue<ScoringJob>(QUEUE.scoring, options);
  const notify = new Queue<NotifyJob>(QUEUE.notify, options);
  const digest = new Queue<DigestJob>(QUEUE.digest, options);
  const maintenance = new Queue<MaintenanceJob>(QUEUE.maintenance, options);
  const deadLetter = new Queue<DeadLetterJob>(QUEUE.deadLetter, options);
  const queues: Queue[] = [
    ...Object.values(ingest),
    scoring,
    notify,
    digest,
    maintenance,
    deadLetter,
  ];

  return {
    ingest,
    scoring,
    notify,
    digest,
    maintenance,
    deadLetter,
    byName: (name) => queues.find((queue) => queue.name === name),
    all: () => [...queues],
    close: async () => {
      await Promise.all(queues.map(async (queue) => queue.close()));
    },
  };
}
