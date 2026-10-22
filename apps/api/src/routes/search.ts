import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { redisKeys } from '@trendr/core';
import { searchItemsFts, searchItemsTrigram } from '@trendr/db';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { nextLinkHeader } from '../schemas/common.js';
import {
  SearchQuery,
  SearchResponse,
  type SearchQueryInput,
  type SearchResponseBody,
} from '../schemas/search.js';
import {
  canonicalSearchQuery,
  composeSearchPage,
  decodeSearchCursor,
  resolveSearchMode,
  toItemSummary,
  type ComposedSearchPage,
} from '../services/search.service.js';

/**
 * Spec §10.1/§9.1/§10.5 — `GET /v1/search`: Postgres FTS over `search_tsv`
 * with the pg_trgm fallback when FTS finds fewer than 5 hits (spec §18 task
 * 3.4), two-part keyset pagination, results cached 120 s under `q:{sha1}`.
 * The body-hash ETag is minted by the etag plugin; `Link: …; rel="next"` is
 * emitted on pages with a next cursor.
 */

const SEARCH_CACHE_TTL_SECONDS = 120;

function toResponse(limit: number, composed: ComposedSearchPage): SearchResponseBody {
  return {
    items: composed.items.map(toItemSummary),
    page: { nextCursor: composed.nextCursor, limit },
  };
}

async function loadSearch(
  app: FastifyInstance,
  query: SearchQueryInput,
): Promise<SearchResponseBody> {
  const db = app.db;
  const cursor = query.cursor === undefined ? null : decodeSearchCursor(query.cursor);
  const fetch = query.limit + 1;

  // Tail pages continue straight inside the trigram part.
  if (cursor !== null && cursor.p === 'trigram') {
    const trigram = await searchItemsTrigram(db, {
      q: query.q,
      source: query.source,
      kind: query.kind,
      fetch,
      after: { score: cursor.k, itemId: BigInt(cursor.i) },
    });
    return toResponse(
      query.limit,
      composeSearchPage({
        mode: cursor.m,
        limit: query.limit,
        cursorPart: 'trigram',
        fts: [],
        trigram,
      }),
    );
  }

  const ftsPage = await searchItemsFts(db, {
    q: query.q,
    source: query.source,
    kind: query.kind,
    fetch,
    after: cursor === null ? undefined : { score: cursor.k, itemId: BigInt(cursor.i) },
  });
  // The mode is fixed by the first page and carried by the cursor afterwards.
  const mode = cursor?.m ?? resolveSearchMode(ftsPage.total);
  // The trigram tail is fetched only when the FTS part did not fill the page,
  // and only up to the remaining slots (its own +1 detects a further page).
  const trigram =
    mode === 'both' && ftsPage.rows.length <= query.limit
      ? await searchItemsTrigram(db, {
          q: query.q,
          source: query.source,
          kind: query.kind,
          fetch: fetch - ftsPage.rows.length,
          after: undefined,
        })
      : [];

  return toResponse(
    query.limit,
    composeSearchPage({
      mode,
      limit: query.limit,
      cursorPart: cursor?.p ?? null,
      fts: ftsPage.rows,
      trigram,
    }),
  );
}

export function registerSearchRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/search',
    {
      config: { cacheControl: CACHE_CONTROL.publicShort },
      schema: { querystring: SearchQuery, response: { 200: SearchResponse } },
    },
    async (request, reply) => {
      const query = request.query;
      const load = (): Promise<SearchResponseBody> => loadSearch(app, query);
      const body = app.hasDecorator('cache')
        ? await app.cache.readThrough(
            redisKeys.queryCache(canonicalSearchQuery(query)),
            SEARCH_CACHE_TTL_SECONDS,
            load,
            'query',
          )
        : await load();
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
