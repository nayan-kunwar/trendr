import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { loadStats } from '@trendr/db';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { StatsResponse } from '../schemas/stats.js';

/**
 * Spec §10.1/§9.4 — `GET /v1/stats`: public operational status (item counts
 * per source, last successful run per source and job type). The endpoint is
 * absent from the §9.4 cache table and the Cloudflare cache rule, so it is
 * served `no-store` with no Redis layer (see SPEC_REVIEW).
 */
export function registerStatsRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/stats',
    {
      config: { cacheControl: CACHE_CONTROL.noStore },
      schema: { response: { 200: StatsResponse } },
    },
    async () => {
      const stats = await loadStats(app.db);
      return {
        items: stats.items,
        runs: stats.runs.map((run) => ({
          source: run.source,
          jobType: run.jobType,
          runId: String(run.runId),
          lastSuccessAt: run.lastSuccessAt.toISOString(),
        })),
      };
    },
  );
}
