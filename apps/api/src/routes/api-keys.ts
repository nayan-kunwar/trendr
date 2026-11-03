import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { UnauthorizedError, UnavailableError } from '@trendr/core';

import { requireUser } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import {
  ApiKeyIdParam,
  ApiKeysResponse,
  CreateApiKeyBody,
  CreateApiKeyResponse,
} from '../schemas/api-keys.js';
import {
  createApiKeyForCurrentUser,
  listApiKeysForCurrentUser,
  revokeApiKeyForCurrentUser,
  type ApiKeyServiceDeps,
} from '../services/api-key.service.js';

/** Spec §10.1/§10.5 — `/v1/me/api-keys` list/create/revoke. */

export interface ApiKeyRoutesOptions {
  /** API_KEY_PEPPER; absent only in tooling builds. */
  pepper?: string;
  now?: () => Date;
}

export function registerApiKeyRoutes(
  app: FastifyInstance,
  options: ApiKeyRoutesOptions = {},
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  const deps = (): ApiKeyServiceDeps => {
    if (!app.hasDecorator('db') || options.pepper === undefined) {
      throw new UnavailableError('API key management is not configured');
    }
    return {
      db: app.db,
      pepper: options.pepper,
      ...(app.hasDecorator('redis') ? { redis: app.redis } : {}),
      ...(options.now === undefined ? {} : { now: options.now }),
    };
  };

  const guard = {
    onRequest: requireUser,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  server.get(
    '/v1/me/api-keys',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'List API keys (prefixes only)',
        response: { 200: ApiKeysResponse },
      },
    },
    async (request) => ({
      apiKeys: await listApiKeysForCurrentUser(deps(), currentUser(request).id),
    }),
  );

  server.post(
    '/v1/me/api-keys',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Create an API key; the full key is returned once',
        body: CreateApiKeyBody,
        response: { 201: CreateApiKeyResponse },
      },
    },
    async (request, reply) => {
      const user = currentUser(request);
      const result = await createApiKeyForCurrentUser(deps(), user.id, request.body);
      return reply.code(201).send(result);
    },
  );

  server.delete(
    '/v1/me/api-keys/:keyId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Revoke an API key',
        params: ApiKeyIdParam,
      },
    },
    async (request, reply) => {
      await revokeApiKeyForCurrentUser(deps(), currentUser(request).id, request.params.keyId);
      return reply.code(204).send();
    },
  );
}

function currentUser(request: FastifyRequest): { id: string; role: 'user' | 'admin' } {
  if (request.authUser === undefined) throw new UnauthorizedError('authentication required');
  return { id: request.authUser.id, role: request.authUser.role };
}
