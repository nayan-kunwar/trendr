import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { UnauthorizedError, UnavailableError } from '@trendr/core';

import { requireUser } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import {
  DigestBody,
  DigestResponse,
  UnsubscribeQuery,
  UnsubscribeResponse,
} from '../schemas/digest.js';
import {
  getDigestForCurrentUser,
  previewUnsubscribe,
  putDigestForCurrentUser,
  unsubscribe,
  type DigestServiceDeps,
  type UnsubscribeDeps,
} from '../services/digest.service.js';

/** Spec §10.1/§13.2 — `/v1/me/digest`; §13.4 — public unsubscribe. */

export function registerDigestRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  const deps = (): DigestServiceDeps => {
    if (!app.hasDecorator('db')) throw new UnavailableError('database is not configured');
    return { db: app.db };
  };

  const guard = {
    onRequest: requireUser,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  server.get(
    '/v1/me/digest',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Read the weekly-digest subscription',
        response: { 200: DigestResponse },
      },
    },
    async (request) => ({
      subscription: await getDigestForCurrentUser(deps(), currentUserId(request)),
    }),
  );

  server.put(
    '/v1/me/digest',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Create or replace the weekly-digest subscription',
        body: DigestBody,
        response: { 200: DigestResponse },
      },
    },
    async (request) => ({
      subscription: await putDigestForCurrentUser(deps(), currentUserId(request), request.body),
    }),
  );
}

export interface UnsubscribeRoutesOptions {
  /** UNSUBSCRIBE_SECRET; absent when tooling builds the OpenAPI document. */
  secret?: string;
  now?: () => Date;
}

export function registerUnsubscribeRoutes(
  app: FastifyInstance,
  options: UnsubscribeRoutesOptions = {},
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );
  }

  const deps = (): UnsubscribeDeps => {
    if (!app.hasDecorator('db') || options.secret === undefined) {
      throw new UnavailableError('unsubscribe is not configured');
    }
    return {
      db: app.db,
      secret: options.secret,
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  };

  // �10.1: GET only describes the token; RFC 8058 POST performs the change.
  server.get(
    '/v1/unsubscribe',
    {
      schema: {
        tags: ['auth'],
        summary: 'Preview an unsubscribe token',
        querystring: UnsubscribeQuery,
        response: { 200: UnsubscribeResponse },
      },
      config: { cacheControl: CACHE_CONTROL.privateNoStore },
    },
    (request) => Promise.resolve(previewUnsubscribe(deps(), request.query.token)),
  );

  server.post(
    '/v1/unsubscribe',
    {
      schema: {
        tags: ['auth'],
        summary: 'One-click unsubscribe (RFC 8058)',
        querystring: UnsubscribeQuery,
        response: { 200: UnsubscribeResponse },
      },
      config: { cacheControl: CACHE_CONTROL.privateNoStore },
    },
    async (request) => unsubscribe(deps(), request.query.token),
  );
}

function currentUserId(request: FastifyRequest): string {
  if (request.authUser === undefined) throw new UnauthorizedError('authentication required');
  return request.authUser.id;
}
