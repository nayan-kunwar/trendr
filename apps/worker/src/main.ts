import type { Worker } from 'bullmq';
import { Redis } from 'ioredis';

import { env } from '@trendr/config';
import { QUEUE, SOURCES } from '@trendr/core';
import { createDb, type Connection } from '@trendr/db';
import { createEmailSender } from '@trendr/email';
import { createLogger } from '@trendr/logger';
import { effectiveHfRatePer5Min } from '@trendr/sources';

import { registerIngestAdapters } from './ingestion/adapters.js';
import { startMetricsServer } from './metrics-server.js';
import { registry } from './metrics.js';
import { createIngestWorker } from './processors/ingest.processor.js';
import { createMaintenanceWorker } from './processors/maintenance.processor.js';
import { createDigestWorker } from './processors/digest.processor.js';
import { createNotifyWorker } from './processors/notify.processor.js';
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
if (roles.includes('scoring') || roles.includes('ingest') || roles.includes('notify')) {
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

    // §3.2: the maintenance role reuses the scoring process (§7.8 retier-items).
    const maintenanceWorker = createMaintenanceWorker({
      db: db.db,
      connection: redis,
      deadLetter: queues.deadLetter,
      logger,
      hotMaxBySource: {
        github: env.TRACKED_HOT_MAX_GITHUB,
        huggingface: env.TRACKED_HOT_MAX_HUGGINGFACE,
      },
    });
    maintenanceWorker.on('completed', () => {
      lastJobByQueue[QUEUE.maintenance] = new Date().toISOString();
    });
    workers.push(maintenanceWorker);
  }

  if (roles.includes('notify')) {
    const sender = createEmailSender({
      provider: env.EMAIL_PROVIDER,
      from: env.EMAIL_FROM,
      smtpUrl: env.SMTP_URL,
      ...(env.RESEND_API_KEY === undefined ? {} : { resendApiKey: env.RESEND_API_KEY }),
    });
    const notifyWorker = createNotifyWorker({
      db: db.db,
      redis,
      connection: redis,
      sender,
      webPublicUrl: env.WEB_PUBLIC_URL,
      apiPublicUrl: env.API_PUBLIC_URL,
      unsubscribeSecret: env.UNSUBSCRIBE_SECRET,
      notifyQueue: queues.notify,
      deadLetter: queues.deadLetter,
      logger,
    });
    notifyWorker.on('completed', () => {
      lastJobByQueue[QUEUE.notify] = new Date().toISOString();
    });
    workers.push(notifyWorker);

    const digestWorker = createDigestWorker({
      db: db.db,
      redis,
      connection: redis,
      sender,
      digestQueue: queues.digest,
      webPublicUrl: env.WEB_PUBLIC_URL,
      apiPublicUrl: env.API_PUBLIC_URL,
      unsubscribeSecret: env.UNSUBSCRIBE_SECRET,
      deadLetter: queues.deadLetter,
      logger,
    });
    digestWorker.on('completed', () => {
      lastJobByQueue[QUEUE.digest] = new Date().toISOString();
    });
    workers.push(digestWorker);
  }

  if (roles.includes('ingest')) {
    registerIngestAdapters(redis, logger);
    const hfTokenPresent = (env.HF_TOKEN?.trim() ?? '') !== '';
    for (const source of SOURCES) {
      const ingestWorker = createIngestWorker(source, {
        deps: {
          db: db.db,
          redis,
          logger,
          scoringQueue: queues.scoring,
          hfRatePer5Min: effectiveHfRatePer5Min(env.HF_RATE_PER_5MIN, hfTokenPresent),
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
