import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import type { FastifyInstance, FastifyRequest } from 'fastify';

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
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'none'"],
        'base-uri': ["'none'"],
        'frame-ancestors': ["'none'"],
      },
    },
  });
  // Swagger UI is a local developer surface; it needs its own inline assets.
  // Keep the deny-all policy for every API route and relax only /docs.
  app.addHook('onSend', (_request, reply, payload) => {
    if (_request.url === '/docs' || _request.url.startsWith('/docs/')) {
      reply.header(
        'content-security-policy',
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; frame-ancestors 'none'",
      );
    }
    return Promise.resolve(payload);
  });
  await app.register(cors, {
    // §15: public GET corpus data is readable from any origin, without
    // credentials. Everything under /v1/me, /v1/admin and /v1/auth keeps the
    // configured allowlist and credentials so cookies are never exposed.
    delegator: (request: FastifyRequest) => {
      const path = (request.url.split('?')[0] ?? '').replace(/\/+$/, '');
      const method =
        request.method === 'OPTIONS'
          ? (request.headers['access-control-request-method'] ?? '').toUpperCase()
          : request.method.toUpperCase();
      const isPrivate =
        path.startsWith('/v1/me') || path.startsWith('/v1/admin') || path.startsWith('/v1/auth');
      const publicGet = method === 'GET' && path.startsWith('/v1/') && !isPrivate;
      return Promise.resolve(
        publicGet
          ? { origin: '*', credentials: false, methods: ['GET', 'HEAD', 'OPTIONS'] }
          : { origin: options.corsOrigins ?? false, credentials: true },
      );
    },
  });
}
