import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

export interface SecurityOptions {
  /** CORS allowlist (env: CORS_ORIGINS). */
  corsOrigins?: string[];
}

/**
 * Helmet + CORS hardening (spec: HTTP security headers and CORS).
 * Route-level `origin: '*'` overrides for public GETs arrive with the API
 * routes; the default here is an allowlist with credentials.
 *
 * Awaited by `buildApp`: both plugins add hooks, and Fastify applies hooks
 * only to routes registered after them.
 */
export async function registerSecurity(
  app: FastifyInstance,
  options: SecurityOptions = {},
): Promise<void> {
  await app.register(helmet, {
    hsts: { maxAge: 31_536_000, includeSubDomains: true },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
  await app.register(cors, {
    origin: options.corsOrigins ?? false,
    credentials: true,
  });
}
