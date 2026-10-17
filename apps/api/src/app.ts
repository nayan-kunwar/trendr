import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import { registerErrors } from './plugins/errors.js';
import { registerMetrics } from './plugins/metrics.js';
import { registerSecurity } from './plugins/security.js';
import { registerHealthRoutes } from './routes/health.js';

export interface BuildAppDeps {
  /** Pre-built pino logger from main.ts; tests omit it for a silent app. */
  loggerInstance?: FastifyBaseLogger;
  trustProxy?: boolean;
  /** CORS allowlist (env: CORS_ORIGINS). */
  corsOrigins?: string[];
  /** Bearer token guarding /metrics (env: METRICS_TOKEN). */
  metricsToken?: string;
}

/**
 * Composition root (spec §4): registers plugins and routes. `main.ts` wires
 * env + logger and listens; tests call this directly with `app.inject`.
 */
export function buildApp(deps: BuildAppDeps = {}): FastifyInstance {
  const app = Fastify({
    trustProxy: deps.trustProxy ?? false,
    ...(deps.loggerInstance ? { loggerInstance: deps.loggerInstance } : {}),
  });

  registerSecurity(app, deps);
  registerErrors(app);
  registerMetrics(app, deps);
  registerHealthRoutes(app);

  return app;
}
