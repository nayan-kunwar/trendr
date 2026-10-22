import {
  ConflictError,
  NotFoundError,
  ValidationError,
  parseAlertParams,
  type AlertParams,
  type AlertType,
} from '@trendr/core';
import {
  countAlertsForUser,
  deleteAlert,
  getAlertForUser,
  getItemById,
  getWatchlistForUser,
  insertAlert,
  listAlertEventsForUser,
  listAlertsForUser,
  updateAlert,
  type AlertRow,
  type Db,
} from '@trendr/db';

import type {
  AlertBody,
  AlertEventBody,
  CreateAlertInput,
  UpdateAlertInput,
} from '../schemas/alerts.js';

/** Spec §13.1 — per-user alert-rule CRUD with a 50-rule cap and 404 IDOR. */

const MAX_ALERTS = 50;

export interface AlertServiceDeps {
  db: Db;
}

function toDto(row: AlertRow): AlertBody {
  return {
    id: row.id,
    type: row.type,
    itemId: row.itemId === null ? null : row.itemId.toString(),
    watchlistId: row.watchlistId,
    window: row.window,
    params: row.params,
    cooldownHours: row.cooldownHours,
    enabled: row.enabled,
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseItemId(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    throw new ValidationError('itemId must be a decimal integer');
  }
}

async function validateTarget(
  deps: AlertServiceDeps,
  userId: string,
  type: AlertType,
  itemId: string | null,
  watchlistId: string | null,
): Promise<{ itemId: bigint | null; watchlistId: string | null }> {
  if (type === 'rank_entered') {
    if (itemId !== null || watchlistId !== null) {
      throw new ValidationError('rank_entered rules have no item or watchlist target');
    }
    return { itemId: null, watchlistId: null };
  }
  if ((itemId === null) === (watchlistId === null)) {
    throw new ValidationError('exactly one of itemId or watchlistId is required');
  }
  if (itemId !== null) {
    const item = await getItemById(deps.db, parseItemId(itemId));
    if (item === null) throw new NotFoundError('item not found');
    return { itemId: item.id, watchlistId: null };
  }
  if (watchlistId !== null) {
    const watchlist = await getWatchlistForUser(deps.db, userId, watchlistId);
    if (watchlist === null) throw new NotFoundError('watchlist not found');
  }
  return { itemId: null, watchlistId };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseParams(type: AlertType, params: unknown): AlertParams {
  try {
    return parseAlertParams(type, params);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid params';
    throw new ValidationError(`invalid ${type} params: ${message}`);
  }
}

export async function listAlertsForCurrentUser(
  deps: AlertServiceDeps,
  userId: string,
): Promise<AlertBody[]> {
  return (await listAlertsForUser(deps.db, userId)).map(toDto);
}

export async function createAlertForCurrentUser(
  deps: AlertServiceDeps,
  userId: string,
  input: CreateAlertInput,
): Promise<AlertBody> {
  if ((await countAlertsForUser(deps.db, userId)) >= MAX_ALERTS) {
    throw new ConflictError(`at most ${MAX_ALERTS} alert rules are allowed`);
  }
  const type = input.params.type;
  const itemId = input.itemId ?? null;
  const watchlistId = input.watchlistId ?? null;
  const target = await validateTarget(deps, userId, type, itemId, watchlistId);
  const row = await insertAlert(deps.db, {
    userId,
    type,
    itemId: target.itemId,
    watchlistId: target.watchlistId,
    window: input.window,
    params: parseParams(type, input.params),
    cooldownHours: input.cooldownHours,
    enabled: true,
  });
  return toDto(row);
}

export async function updateAlertForCurrentUser(
  deps: AlertServiceDeps,
  userId: string,
  alertId: string,
  patch: UpdateAlertInput,
): Promise<AlertBody> {
  const existing = await getAlertForUser(deps.db, userId, alertId);
  if (existing === null) throw new NotFoundError('alert not found');

  const type = patch.type ?? existing.type;
  const itemId =
    patch.itemId !== undefined
      ? patch.itemId
      : patch.watchlistId !== undefined
        ? null
        : existing.itemId === null
          ? null
          : existing.itemId.toString();
  const watchlistId =
    patch.watchlistId !== undefined
      ? patch.watchlistId
      : patch.itemId !== undefined
        ? null
        : existing.watchlistId;
  const target = await validateTarget(deps, userId, type, itemId, watchlistId);

  let params: AlertParams;
  if (patch.params !== undefined) {
    if (!isRecord(patch.params)) throw new ValidationError('params must be an object');
    params = parseParams(type, patch.params);
  } else if (type !== existing.type) {
    if (type === 'threshold_crossed') {
      throw new ValidationError('params are required when changing to threshold_crossed');
    }
    params = parseParams(type, {});
  } else {
    params = parseParams(type, existing.params);
  }

  const row = await updateAlert(deps.db, userId, alertId, {
    type,
    itemId: target.itemId,
    watchlistId: target.watchlistId,
    window: patch.window ?? existing.window,
    params,
    cooldownHours: patch.cooldownHours ?? existing.cooldownHours,
    enabled: patch.enabled ?? existing.enabled,
  });
  if (row === null) throw new NotFoundError('alert not found');
  return toDto(row);
}

export async function deleteAlertForCurrentUser(
  deps: AlertServiceDeps,
  userId: string,
  alertId: string,
): Promise<void> {
  if (!(await deleteAlert(deps.db, userId, alertId))) {
    throw new NotFoundError('alert not found');
  }
}

export async function listAlertEventsForCurrentUser(
  deps: AlertServiceDeps,
  userId: string,
  options: { cursor?: string | undefined; limit: number },
): Promise<{ events: AlertEventBody[]; nextCursor: string | null }> {
  let beforeId: bigint | undefined;
  if (options.cursor !== undefined) {
    try {
      beforeId = BigInt(options.cursor);
    } catch {
      throw new ValidationError('cursor must be an alert-event id');
    }
  }
  const rows = await listAlertEventsForUser(deps.db, userId, {
    ...(beforeId === undefined ? {} : { beforeId }),
    limit: options.limit + 1,
  });
  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    events: page.map((row) => ({
      id: row.event.id.toString(),
      alertId: row.event.alertId,
      alertType: row.alertType,
      window: row.window,
      item: {
        id: row.item.id.toString(),
        source: row.item.source,
        displayName: row.item.displayName,
        url: row.item.url,
      },
      payload: row.event.payload,
      triggeredAt: row.event.triggeredAt.toISOString(),
      deliveredAt: row.event.deliveredAt?.toISOString() ?? null,
      deliveryStatus: row.event.deliveryStatus as AlertEventBody['deliveryStatus'],
    })),
    nextCursor: rows.length > options.limit && last !== undefined ? last.event.id.toString() : null,
  };
}
