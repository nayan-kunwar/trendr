import type { Queue } from 'bullmq';

import type { Logger } from '@trendr/logger';

import { queueDepth } from '../metrics.js';
import type { Queues } from '../queues.js';

/** Spec §14.1: queue depth is polled from BullMQ every 15 s. */
export const QUEUE_DEPTH_INTERVAL_MS = 15_000;

export type QueueDepthObserver = (queue: string, state: string, value: number) => void;

export interface QueueDepthPollerOptions {
  queues: Queues | readonly Queue[];
  intervalMs?: number;
  logger?: Logger;
  /** Test seam; defaults to the shared `trendr_queue_depth` gauge. */
  observe?: QueueDepthObserver;
  /** Run one poll immediately on start (default true). */
  immediate?: boolean;
}

export interface RunningQueueDepthPoller {
  poll(): Promise<void>;
  stop(): void;
}

/** All BullMQ queues, in a stable order (used by the metrics poller and tests). */
export function allQueues(queues: Queues): Queue[] {
  return [
    ...Object.values(queues.ingest),
    queues.scoring,
    queues.notify,
    queues.digest,
    queues.maintenance,
    queues.deadLetter,
  ];
}

export function startQueueDepthPoller(options: QueueDepthPollerOptions): RunningQueueDepthPoller {
  const queues: readonly Queue[] =
    'ingest' in options.queues ? allQueues(options.queues) : options.queues;
  const observe: QueueDepthObserver =
    options.observe ??
    ((queue, state, value) => {
      queueDepth.set({ queue, state }, value);
    });
  let stopped = false;
  let inFlight = false;

  async function poll(): Promise<void> {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // Reset between polls so a removed queue/state never leaves a stale series.
      queueDepth.reset();
      const results = await Promise.allSettled(
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
          return { queue: queue.name, counts };
        }),
      );
      for (const result of results) {
        if (result.status === 'rejected') {
          options.logger?.warn({ err: result.reason }, 'queue-depth poll failed');
          continue;
        }
        const { queue, counts } = result.value;
        observe(queue, 'waiting', counts.waiting ?? 0);
        observe(queue, 'active', counts.active ?? 0);
        observe(queue, 'delayed', counts.delayed ?? 0);
        observe(queue, 'failed', counts.failed ?? 0);
      }
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    void poll();
  }, options.intervalMs ?? QUEUE_DEPTH_INTERVAL_MS);
  timer.unref();
  if (options.immediate !== false) void poll();

  return {
    poll,
    stop(): void {
      stopped = true;
      clearInterval(timer);
    },
  };
}
