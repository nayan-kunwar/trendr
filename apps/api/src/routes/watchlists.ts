import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { NotFoundError, UnauthorizedError, UnavailableError } from '@trendr/core';

import { requireUser } from '../plugins/auth.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import {
  CreateWatchlistBody,
  RenameWatchlistBody,
  WatchlistDto,
  WatchlistIdParam,
  WatchlistItemParam,
  WatchlistItemWriteResponse,
  WatchlistItemsResponse,
  WatchlistsResponse,
} from '../schemas/watchlists.js';
import { MAX_ITEM_ID } from '../schemas/common.js';
import {
  addItemToWatchlistForUser,
  createWatchlistForUser,
  deleteWatchlistForUser,
  getWatchlistContents,
  listWatchlistsForUser,
  removeItemFromWatchlistForUser,
  renameWatchlistForUser,
  type WatchlistServiceDeps,
} from '../services/watchlist.service.js';
import type { ApiQueues } from '../queues.js';

/**
 * Spec §10.5 / task 7.2 — `/v1/me/watchlists` CRUD and membership. Adding an
 * item is an idempotent PUT; every resource is scoped to the authenticated
 * user, so foreign ids produce a 404 rather than a 403 (no existence leak).
 */

export interface WatchlistRoutesOptions {
  queues?: ApiQueues;
  now?: () => Date;
}

export function registerWatchlistRoutes(
  app: FastifyInstance,
  options: WatchlistRoutesOptions = {},
): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  const deps = (): WatchlistServiceDeps => {
    if (!app.hasDecorator('db')) throw new UnavailableError('database is not configured');
    const value: WatchlistServiceDeps = { db: app.db };
    if (options.queues !== undefined) value.queues = options.queues;
    if (options.now !== undefined) value.now = options.now;
    return value;
  };

  const guard = {
    onRequest: requireUser,
    config: { cacheControl: CACHE_CONTROL.privateNoStore },
  };

  server.get(
    '/v1/me/watchlists',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'List the current user’s watchlists',
        response: { 200: WatchlistsResponse },
      },
    },
    async (request) => ({
      watchlists: await listWatchlistsForUser(deps(), currentUserId(request)),
    }),
  );

  server.post(
    '/v1/me/watchlists',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Create a watchlist (max 20 per user)',
        body: CreateWatchlistBody,
        response: { 201: WatchlistDto },
      },
    },
    async (request, reply) => {
      const watchlist = await createWatchlistForUser(
        deps(),
        currentUserId(request),
        request.body.name,
      );
      return reply.code(201).send(watchlist);
    },
  );

  server.patch(
    '/v1/me/watchlists/:watchlistId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Rename a watchlist',
        params: WatchlistIdParam,
        body: RenameWatchlistBody,
        response: { 200: WatchlistDto },
      },
    },
    async (request) =>
      renameWatchlistForUser(
        deps(),
        currentUserId(request),
        request.params.watchlistId,
        request.body.name,
      ),
  );

  server.delete(
    '/v1/me/watchlists/:watchlistId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Delete a watchlist and its items',
        params: WatchlistIdParam,
      },
    },
    async (request, reply) => {
      await deleteWatchlistForUser(deps(), currentUserId(request), request.params.watchlistId);
      return reply.code(204).send();
    },
  );

  server.get(
    '/v1/me/watchlists/:watchlistId/items',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Watchlist items with current 24h/7d scores',
        params: WatchlistIdParam,
        response: { 200: WatchlistItemsResponse },
      },
    },
    async (request) =>
      getWatchlistContents(deps(), currentUserId(request), request.params.watchlistId),
  );

  server.put(
    '/v1/me/watchlists/:watchlistId/items/:itemId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Add an item (idempotent) and promote it to the hot tier',
        params: WatchlistItemParam,
        response: { 200: WatchlistItemWriteResponse },
      },
    },
    async (request) =>
      addItemToWatchlistForUser(
        deps(),
        currentUserId(request),
        request.params.watchlistId,
        parseItemId(request.params.itemId),
      ),
  );

  server.delete(
    '/v1/me/watchlists/:watchlistId/items/:itemId',
    {
      ...guard,
      schema: {
        tags: ['me'],
        summary: 'Remove an item from a watchlist',
        params: WatchlistItemParam,
      },
    },
    async (request, reply) => {
      await removeItemFromWatchlistForUser(
        deps(),
        currentUserId(request),
        request.params.watchlistId,
        parseItemId(request.params.itemId),
      );
      return reply.code(204).send();
    },
  );
}

function currentUserId(request: FastifyRequest): string {
  if (request.authUser === undefined) throw new UnauthorizedError('authentication required');
  return request.authUser.id;
}

function parseItemId(raw: string): bigint {
  const id = BigInt(raw);
  if (id > MAX_ITEM_ID) throw new NotFoundError('item not found');
  return id;
}
