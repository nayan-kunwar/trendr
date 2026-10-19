import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { env } from '@trendr/config';
import { QUEUE, SOURCES } from '@trendr/core';
import { createDb, type Connection } from '@trendr/db';
import { createLogger } from '@trendr/logger';

import { registerIngestAdapters } from './ingestion/adapters.js';
import { startMetricsServer } from './metrics-server.js';
import { registry } from './metrics.js';
import { createIngestWorker } from './processors/ingest.processor.js';
import { closeQueues, createQueues } from './queues.js';
import { registerSchedulers } from './scheduler.js';
import { createScoringWorker } from './scoring/processor.js';

const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

// BullMQ requires maxRetriesPerRequest: null (spec §3); ioredis reconnects on its own.
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (error: unknown) => {
  logger.error({ err: error }, 'redis connection error');
});

const roles = env.WORKER_ROLES;
const queues = createQueues(redis);

/** Last successful job timestamp per queue, served by `/healthz` (spec §14.4). */
const lastJobByQueue: Record<string, string | null> = {};

let schedulerIds: string[] = [];
if (roles.includes('scheduler') && env.SCHEDULER_ENABLED) {
  schedulerIds = await registerSchedulers(queues, logger);
}

const workers: Worker[] = [];
let db: Connection | null = null;
if (roles.includes('scoring') || roles.includes('ingest')) {
  db = createDb(env.DATABASE_URL);

  if (roles.includes('scoring')) {
    const scoringWorker = createScoringWorker({
      db: db.db,
      redis,
      connection: redis,
      notifyQueue: queues.notify,
      deadLetter: queues.deadLetter,
      logger,
    });
    scoringWorker.on('completed', () => {
      lastJobByQueue[QUEUE.scoring] = new Date().toISOString();
    });
    workers.push(scoringWorker);
  }

  if (roles.includes('ingest')) {
    registerIngestAdapters(redis, logger);
    for (const source of SOURCES) {
      const ingestWorker = createIngestWorker(source, {
        deps: {
          db: db.db,
          redis,
          logger,
          scoringQueue: queues.scoring,
          hfRatePer5Min: env.HF_RATE_PER_5MIN,
          fanoutBatchItems: env.FANOUT_BATCH_ITEMS,
          ingestQueue: queues.ingest[source],
        },
        connection: redis,
        concurrency: env.WORKER_CONCURRENCY_INGEST,
        deadLetter: queues.deadLetter,
      });
      ingestWorker.on('completed', () => {
        lastJobByQueue[QUEUE.ingest[source]] = new Date().toISOString();
      });
      workers.push(ingestWorker);
    }
  }
}

const metricsServer = await startMetricsServer({
  port: env.WORKER_METRICS_PORT,
  metricsToken: env.METRICS_TOKEN,
  registry,
  logger,
  getHealth: () => ({
    redis: redis.status === 'ready' ? 'connected' : 'disconnected',
    schedulerRegistered: schedulerIds.length > 0,
    lastJobByQueue,
  }),
});

logger.info({ port: metricsServer.port, roles, schedulers: schedulerIds }, 'worker started');

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'worker stopping');
  try {
    await metricsServer.close();
    for (const worker of workers) {
      await worker.close();
    }
    await closeQueues(queues);
    if (db !== null) {
      await db.pool.end();
    }
    await redis.quit();
    logger.info({ signal }, 'worker stopped');
    process.exit(0);
  } catch (error: unknown) {
    logger.error({ err: error }, 'worker failed to stop');
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
