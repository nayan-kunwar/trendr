import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { requireAdmin } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import type { ApiQueues } from '../queues.js';
import {
  AdminDlqParams,
  AdminDlqQuery,
  AdminDlqResponse,
  AdminDlqRetryResponse,
  AdminIngestBody,
  AdminIngestResponse,
  AdminItemParams,
  AdminItemPatchBody,
  AdminItemPatchResponse,
  AdminQueuesResponse,
  AdminRateLimitsResponse,
  AdminRunParams,
  AdminRunResponse,
  AdminRunsQuery,
  AdminRunsResponse,
  AdminScoreBody,
  AdminScoreResponse,
} from '../schemas/admin.js';
import { nextLinkHeader } from '../schemas/common.js';
import {
  deleteDlq,
  getAdminRun,
  getRateLimits,
  listAdminRuns,
  listDlq,
  listQueueCounts,
  patchAdminItem,
  resolveAdminQueues,
  retryDlq,
  triggerIngest,
  triggerScore,
  type AdminDeps,
} from '../services/admin.service.js';

/**
 * Spec §10.1 — `/v1/admin/*`: ingest/score triggers, runs, queue depths, DLQ
 * inspection/replay, rate-limit state and item patches. Every route requires
 * an admin JWT or an `admin`-scope API key (§10.5); authenticated non-admins
 * get 403 and anonymous callers 401. Responses are `private, no-store`.
 */

export interface AdminRoutesOptions {
  /** Queue producers. Omitted only by tooling builds (OpenAPI export). */
  queues?: ApiQueues;
  /** Injectable clock (tests). */
  now?: () => Date;
}

export function registerAdminRoutes(app: FastifyInstance, options: AdminRoutesOptions = {}): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  const deps = (): AdminDeps => ({
    db: app.db,
    redis: app.redis,
    queues: resolveAdminQueues(app.hasDecorator('db'), app.hasDecorator('redis'), options.queues),
    invalidate: async (key) => {
      if (app.hasDecorator('cache')) {
        await app.cache.invalidate(key);
      }
    },
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const guard = {
    onRequest: requireAdmin,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  server.post(
    '/v1/admin/ingest',
    {
      ...guard,
      schema: {
        body: AdminIngestBody,
        response: { 202: AdminIngestResponse },
      },
    },
    async (request, reply) => {
      const body = await triggerIngest(deps(), request.body);
      return reply.code(202).send(body);
    },
  );

  server.post(
    '/v1/admin/score',
    {
      ...guard,
      schema: { body: AdminScoreBody, response: { 202: AdminScoreResponse } },
    },
    async (request, reply) => {
      const body = await triggerScore(deps(), request.body.source);
      return reply.code(202).send(body);
    },
  );

  server.get(
    '/v1/admin/runs',
    {
      ...guard,
      schema: { querystring: AdminRunsQuery, response: { 200: AdminRunsResponse } },
    },
    async (request, reply) => {
      const body = await listAdminRuns(deps(), request.query);
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

  server.get(
    '/v1/admin/runs/:runId',
    {
      ...guard,
      schema: { params: AdminRunParams, response: { 200: AdminRunResponse } },
    },
    async (request) => getAdminRun(deps(), BigInt(request.params.runId)),
  );

  server.get(
    '/v1/admin/queues',
    { ...guard, schema: { response: { 200: AdminQueuesResponse } } },
    async () => listQueueCounts(deps()),
  );

  server.get(
    '/v1/admin/dlq',
    { ...guard, schema: { querystring: AdminDlqQuery, response: { 200: AdminDlqResponse } } },
    async (request, reply) => {
      const body = await listDlq(deps(), request.query.cursor);
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

  server.post(
    '/v1/admin/dlq/:jobId/retry',
    {
      ...guard,
      schema: { params: AdminDlqParams, response: { 202: AdminDlqRetryResponse } },
    },
    async (request, reply) => {
      const body = await retryDlq(deps(), request.params.jobId);
      return reply.code(202).send(body);
    },
  );

  server.delete(
    '/v1/admin/dlq/:jobId',
    { ...guard, schema: { params: AdminDlqParams } },
    async (request, reply) => {
      await deleteDlq(deps(), request.params.jobId);
      return reply.code(204).send();
    },
  );

  server.get(
    '/v1/admin/rate-limits',
    { ...guard, schema: { response: { 200: AdminRateLimitsResponse } } },
    async () => getRateLimits(deps()),
  );

  server.patch(
    '/v1/admin/items/:id',
    {
      ...guard,
      schema: {
        params: AdminItemParams,
        body: AdminItemPatchBody,
        response: { 200: AdminItemPatchResponse },
      },
    },
    async (request) => {
      const id = BigInt(request.params.id);
      return patchAdminItem(deps(), id, request.body);
    },
  );
}
