import { env } from '@trendr/config';
import { createDb } from '@trendr/db';
import { createLogger } from '@trendr/logger';
import { Redis } from 'ioredis';

import { buildApp } from './app.js';

const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });

const connection = createDb(env.DATABASE_URL, { max: env.DATABASE_POOL_MAX });
const redis = new Redis(env.REDIS_URL, {
  // Fail fast so the cache breaker can degrade to Postgres (spec §9.3)
  // instead of queueing commands while Redis reconnects.
  enableOfflineQueue: false,
  maxRetriesPerRequest: 1,
  connectTimeout: 5_000,
});
redis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'redis connection error');
});

const app = await buildApp({
  loggerInstance: logger,
  trustProxy: env.TRUST_PROXY,
  corsOrigins: env.CORS_ORIGINS,
  metricsToken: env.METRICS_TOKEN,
  db: connection,
  redis,
  scoresRetention: {
    hourlyHours: env.SCORES_HOURLY_RETENTION_HOURS,
    dailyDays: env.SCORES_DAILY_RETENTION_DAYS,
  },
  openapi: { serverUrl: env.API_PUBLIC_URL },
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  try {
    await app.close();
    await connection.pool.end();
    try {
      await redis.quit();
    } catch {
      redis.disconnect();
    }
    logger.info({ signal }, 'api stopped');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'api failed to stop');
    process.exit(1);
  }
}

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (error) {
  logger.error({ err: error }, 'api failed to start');
  process.exit(1);
}
