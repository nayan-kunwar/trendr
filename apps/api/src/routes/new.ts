import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { ValidationError } from '@trendr/core';
import { listNewItems, type ItemSummaryRow } from '@trendr/db';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { KeysetCursor, decodeCursor, encodeCursor, nextLinkHeader } from '../schemas/common.js';
import {
  NewQuery,
  NewResponse,
  type NewQueryInput,
  type NewResponseBody,
} from '../schemas/search.js';
import { toItemSummary } from '../services/search.service.js';

/**
 * Spec §10.1/§10.5 — `GET /v1/new`: items discovered upstream within `days`,
 * newest first. The spec lists no `limit` parameter, so pages are fixed at 50;
 * the cursor is a `(upstream_created_at, id)` keyset. Cache-Control is the
 * §9.4 `publicShort` set and the body-hash ETag comes from the etag plugin.
 */

/** Spec §10.1: no `limit` param — fixed page size. */
export const NEW_PAGE_SIZE = 50;
const DAY_MS = 86_400_000;

export function decodeNewCursor(raw: string): { createdAt: Date; itemId: bigint } {
  try {
    const cursor = decodeCursor(raw, KeysetCursor);
    const key = typeof cursor.k === 'string' ? cursor.k : String(cursor.k);
    const createdAt = new Date(key);
    if (Number.isNaN(createdAt.getTime()) || !/^\d{1,19}$/.test(cursor.i)) {
      throw new Error('malformed cursor');
    }
    return { createdAt, itemId: BigInt(cursor.i) };
  } catch {
    throw new ValidationError('Invalid cursor');
  }
}

type DatedItemRow = ItemSummaryRow & { upstreamCreatedAt: Date };

async function readNew(app: FastifyInstance, query: NewQueryInput): Promise<NewResponseBody> {
  const cursor = query.cursor === undefined ? undefined : decodeNewCursor(query.cursor);
  const since = new Date(Date.now() - query.days * DAY_MS);
  const rows = await listNewItems(app.db, {
    source: query.source,
    kind: query.kind,
    since,
    fetch: NEW_PAGE_SIZE + 1,
    after: cursor,
  });
  // The SQL filter guarantees a non-null timestamp; narrow it for the cursor.
  const dated = rows.filter((row): row is DatedItemRow => row.upstreamCreatedAt !== null);
  const page = dated.slice(0, NEW_PAGE_SIZE);
  const last = page.at(-1);
  return {
    items: page.map(toItemSummary),
    page: {
      nextCursor:
        dated.length > NEW_PAGE_SIZE && last !== undefined
          ? encodeCursor({ k: last.upstreamCreatedAt.toISOString(), i: String(last.id) })
          : null,
      limit: NEW_PAGE_SIZE,
    },
  };
}

export function registerNewRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/new',
    {
      config: { cacheControl: CACHE_CONTROL.publicShort },
      schema: { querystring: NewQuery, response: { 200: NewResponse } },
    },
    async (request, reply) => {
      const body = await readNew(app, request.query);
      if (body.page.nextCursor !== null) {
        reply.header(
          'link',
          nextLinkHeader(
            `${request.protocol}://${request.host}`,
            request.url,
            body.page.nextCursor,
          ),
        );
      }
      return body;
    },
  );
}
