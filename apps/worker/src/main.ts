import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { env } from '@trendr/config';
import { QUEUE } from '@trendr/core';
import { createDb, type Connection } from '@trendr/db';
import { createLogger } from '@trendr/logger';

import { startMetricsServer } from './metrics-server.js';
import { registry } from './metrics.js';
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

let db: Connection | null = null;
let scoringWorker: Worker | null = null;
if (roles.includes('scoring')) {
  db = createDb(env.DATABASE_URL);
  scoringWorker = createScoringWorker({
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
    if (scoringWorker !== null) {
      await scoringWorker.close();
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
