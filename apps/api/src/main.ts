import { env } from '@trendr/config';
import { createLogger } from '@trendr/logger';

import { buildApp } from './app.js';

const logger = createLogger({ service: 'api', level: env.LOG_LEVEL });

const app = buildApp({
  loggerInstance: logger,
  trustProxy: env.TRUST_PROXY,
  corsOrigins: env.CORS_ORIGINS,
  metricsToken: env.METRICS_TOKEN,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => {
        logger.info({ signal }, 'api stopped');
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error({ err: error }, 'api failed to stop');
        process.exit(1);
      });
  });
}

try {
  await app.listen({ port: env.API_PORT, host: '0.0.0.0' });
} catch (error) {
  logger.error({ err: error }, 'api failed to start');
  process.exit(1);
}
