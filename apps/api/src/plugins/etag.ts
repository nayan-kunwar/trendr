import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

/**
 * Spec §9.4 per-route `Cache-Control` values; routes attach one via
 * `config: { cacheControl: CACHE_CONTROL.publicLong }`.
 */
export const CACHE_CONTROL = {
  /** Public GETs: trending, items/:id, history, scores, aliases. */
  publicLong: 'public, max-age=60, s-maxage=300, stale-while-revalidate=600',
  /** Public GETs: search, topics, languages, new, compare. */
  publicShort: 'public, max-age=60, s-maxage=120',
  /** /v1/me/*, /v1/auth/*, /v1/admin/*. */
  privateNoStore: 'private, no-store',
  /** /metrics, /healthz, /readyz. */
  noStore: 'no-store',
  /** SSE stream. */
  sse: 'no-cache, no-transform',
} as const;

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Cache-Control applied by the etag plugin (spec §9.4). */
    cacheControl?: string;
  }
}

/** `W/"{sha1(body)}"` — the spec's weak body-hash ETag (§9.4). */
export function weakEtag(payload: string | Buffer): string {
  return `W/"${createHash('sha1').update(payload).digest('hex')}"`;
}

/** RFC 9110 §13.1.2: `*`, or a list compared with the weak comparison algorithm. */
export function ifNoneMatchMatches(header: string | string[] | undefined, etag: string): boolean {
  if (header === undefined) {
    return false;
  }
  const normalize = (tag: string): string => (tag.startsWith('W/') ? tag.slice(2) : tag);
  const value = Array.isArray(header) ? header.join(',') : header;
  return value.split(',').some((candidate) => {
    const tag = candidate.trim();
    return tag === '*' || normalize(tag) === normalize(etag);
  });
}

/**
 * Weak ETag + 304 for GET/HEAD (spec §9.4) and the route-level Cache-Control
 * helper. An ETag the route set itself (e.g. the trending board's `lb-…` tag)
 * wins; the plugin only mints one when the route set none.
 */
export function registerEtag(app: FastifyInstance): void {
  app.addHook('onSend', (request, reply, payload, done) => {
    const { cacheControl } = request.routeOptions.config;
    if (typeof cacheControl === 'string') {
      reply.header('cache-control', cacheControl);
    }
    if (
      (request.method !== 'GET' && request.method !== 'HEAD') ||
      reply.statusCode !== 200 ||
      (typeof payload !== 'string' && !Buffer.isBuffer(payload))
    ) {
      done(null, payload);
      return;
    }
    if (!reply.hasHeader('etag')) {
      reply.header('etag', weakEtag(payload));
    }
    const etag = reply.getHeader('etag');
    if (typeof etag === 'string' && ifNoneMatchMatches(request.headers['if-none-match'], etag)) {
      reply.code(304);
      reply.removeHeader('content-type');
      reply.removeHeader('content-length');
      done(null, '');
      return;
    }
    done(null, payload);
  });
}
