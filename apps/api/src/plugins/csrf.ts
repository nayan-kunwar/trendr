import type { FastifyInstance } from 'fastify';

import { ForbiddenError } from '@trendr/core';

/** Spec §15: custom-header CSRF defence for cookie-authenticated writes. */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'trendr';
export const REFRESH_COOKIE_NAME = 'dt_refresh';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Browsers can send the httpOnly refresh cookie cross-site on simple form
 * posts, but they cannot add this custom header without a CORS preflight that
 * our allowlist rejects. Requests authenticated only by bearer/API key have no
 * cookie and therefore need no token; the refresh/logout routes do carry the
 * cookie and are protected too.
 */
export function registerCsrf(app: FastifyInstance): void {
  // eslint-disable-next-line @typescript-eslint/require-await -- Fastify hook contract: sync hooks can stall the chain.
  app.addHook('preHandler', async (request) => {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return;
    const cookie = request.cookies[REFRESH_COOKIE_NAME];
    if (typeof cookie !== 'string' || cookie.length === 0) return;
    if (request.headers[CSRF_HEADER] === CSRF_HEADER_VALUE) return;
    throw new ForbiddenError('missing CSRF header');
  });
}
