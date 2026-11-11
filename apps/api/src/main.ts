import { env } from '@trendr/config';
import { createDb } from '@trendr/db';
import { createEmailSender } from '@trendr/email';
import { createLogger } from '@trendr/logger';
import { Redis } from 'ioredis';

import { buildApp } from './app.js';
import { createOAuthProviders } from './services/oauth/providers.js';

const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });

const emailSender = createEmailSender({
  provider: env.EMAIL_PROVIDER,
  from: env.EMAIL_FROM,
  smtpUrl: env.SMTP_URL,
  logger,
  ...(env.RESEND_API_KEY === undefined ? {} : { resendApiKey: env.RESEND_API_KEY }),
});

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

/**
 * BullMQ producers need a connection that never gives up on reconnects (the
 * cache client above fails fast for §9.3); the app closes the queues, this
 * module closes the client.
 */
const queueRedis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
queueRedis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'queue redis connection error');
});

// ADR-0034: only fully configured providers are advertised; env validation
// already rejects a half-configured pair at boot.
const oauthProviders = createOAuthProviders({
  apiPublicUrl: env.API_PUBLIC_URL,
  ...(env.GOOGLE_CLIENT_ID === undefined || env.GOOGLE_CLIENT_SECRET === undefined
    ? {}
    : {
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      }),
  ...(env.GITHUB_CLIENT_ID === undefined || env.GITHUB_CLIENT_SECRET === undefined
    ? {}
    : {
        github: {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
        },
      }),
});

const app = await buildApp({
  loggerInstance: logger,
  trustProxy: env.TRUST_PROXY,
  corsOrigins: env.CORS_ORIGINS,
  metricsToken: env.METRICS_TOKEN,
  db: connection,
  redis,
  apiKeyPepper: env.API_KEY_PEPPER,
  jwtSecret: env.JWT_SECRET,
  auth: {
    emailSender,
    webPublicUrl: env.WEB_PUBLIC_URL,
    adminEmails: env.ADMIN_EMAILS,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    accessTokenTtlSeconds: env.JWT_ACCESS_TTL_SEC,
    cookieSecure: env.NODE_ENV === 'production',
    cookieSameSite: env.COOKIE_SAME_SITE,
  },
  oauth: {
    providers: oauthProviders,
    webPublicUrl: env.WEB_PUBLIC_URL,
    adminEmails: env.ADMIN_EMAILS,
    refreshTtlDays: env.REFRESH_TTL_DAYS,
    cookieSecure: env.NODE_ENV === 'production',
    cookieSameSite: env.COOKIE_SAME_SITE,
  },
  queueConnection: queueRedis,
  unsubscribeSecret: env.UNSUBSCRIBE_SECRET,
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
    try {
      await queueRedis.quit();
    } catch {
      queueRedis.disconnect();
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
