import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { UnauthorizedError, UnavailableError } from '@trendr/core';

import { requireUser } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import {
  AlertDto,
  AlertEventsQuery,
  AlertEventsResponse,
  AlertIdParam,
  AlertsResponse,
  CreateAlertBody,
  UpdateAlertBody,
} from '../schemas/alerts.js';
import {
  createAlertForCurrentUser,
  deleteAlertForCurrentUser,
  listAlertEventsForCurrentUser,
  listAlertsForCurrentUser,
  updateAlertForCurrentUser,
  type AlertServiceDeps,
} from '../services/alert.service.js';

/** Spec §10.1/§13.1 — `/v1/me/alerts` CRUD and the fired-alert feed. */

export function registerAlertRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  const deps = (): AlertServiceDeps => {
    if (!app.hasDecorator('db')) throw new UnavailableError('database is not configured');
    return { db: app.db };
  };

  const guard = {
    onRequest: requireUser,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  server.get(
    '/v1/me/alerts',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'List alert rules',
        response: { 200: AlertsResponse },
      },
    },
    async (request) => ({ alerts: await listAlertsForCurrentUser(deps(), currentUserId(request)) }),
  );

  server.post(
    '/v1/me/alerts',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Create an alert rule (max 50 per user)',
        body: CreateAlertBody,
        response: { 201: AlertDto },
      },
    },
    async (request, reply) => {
      const alert = await createAlertForCurrentUser(deps(), currentUserId(request), request.body);
      return reply.code(201).send(alert);
    },
  );

  server.patch(
    '/v1/me/alerts/:alertId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Update an alert rule',
        params: AlertIdParam,
        body: UpdateAlertBody,
        response: { 200: AlertDto },
      },
    },
    async (request) =>
      updateAlertForCurrentUser(
        deps(),
        currentUserId(request),
        request.params.alertId,
        request.body,
      ),
  );

  server.delete(
    '/v1/me/alerts/:alertId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Delete an alert rule and its events',
        params: AlertIdParam,
      },
    },
    async (request, reply) => {
      await deleteAlertForCurrentUser(deps(), currentUserId(request), request.params.alertId);
      return reply.code(204).send();
    },
  );

  server.get(
    '/v1/me/alert-events',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Fired alerts, newest first',
        querystring: AlertEventsQuery,
        response: { 200: AlertEventsResponse },
      },
    },
    async (request) => listAlertEventsForCurrentUser(deps(), currentUserId(request), request.query),
  );
}

function currentUserId(request: FastifyRequest): string {
  if (request.authUser === undefined) throw new UnauthorizedError('authentication required');
  return request.authUser.id;
}
