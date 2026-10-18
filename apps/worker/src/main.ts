import { Redis } from 'ioredis';

import { env } from '@trendr/config';
import { createLogger } from '@trendr/logger';

import { startMetricsServer } from './metrics-server.js';
import { registry } from './metrics.js';

const logger = createLogger({ service: 'worker', level: env.LOG_LEVEL });

// BullMQ requires maxRetriesPerRequest: null (spec §3); ioredis reconnects on its own.
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
redis.on('error', (error: unknown) => {
  logger.error({ err: error }, 'redis connection error');
});

const metricsServer = await startMetricsServer({
  port: env.WORKER_METRICS_PORT,
  metricsToken: env.METRICS_TOKEN,
  registry,
  logger,
  getHealth: () => ({
    redis: redis.status === 'ready' ? 'connected' : 'disconnected',
    schedulerRegistered: false, // scheduler definitions arrive in Phase 3
    lastJobByQueue: {}, // populated once processors exist
  }),
});

logger.info(
  { port: metricsServer.port, roles: env.WORKER_ROLES },
  'worker started (processors arrive in later phases)',
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, 'worker stopping');
  try {
    await metricsServer.close();
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
