import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { listLanguages, listTopics } from '@trendr/db';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { LanguagesResponse, TopicsQuery, TopicsResponse } from '../schemas/topics.js';

/**
 * Spec §10.1 — `GET /v1/topics` (live per-topic counts, optional `source`
 * filter, `limit` ≤ 200) and `GET /v1/languages` (§9.1: the top 30 languages
 * by item count — the candidate set for the Phase 6 language boards).
 */

const TOP_LANGUAGES = 30;

export function registerTopicRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/topics',
    {
      config: { cacheControl: CACHE_CONTROL.publicShort },
      schema: { querystring: TopicsQuery, response: { 200: TopicsResponse } },
    },
    async (request) => ({
      topics: await listTopics(app.db, {
        source: request.query.source,
        limit: request.query.limit,
      }),
    }),
  );

  server.get(
    '/v1/languages',
    {
      config: { cacheControl: CACHE_CONTROL.publicShort },
      schema: { response: { 200: LanguagesResponse } },
    },
    async () => {
      const languages = await listLanguages(app.db, TOP_LANGUAGES);
      return {
        languages: languages.map((row) => ({
          language: row.language,
          slug: row.language.trim().toLowerCase(),
          itemCount: row.itemCount,
        })),
      };
    },
  );
}
