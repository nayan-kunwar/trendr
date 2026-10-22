import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';

import type { AlertParams, AlertType, Source, Window } from '@trendr/core';

import type { DbExecutor } from '../client.js';
import { alerts, alertEvents, watchlistItems } from '../schema/engagement.js';
import { items } from '../schema/items.js';

/** Spec §13.1 alert persistence and §10.1 `/v1/me/alerts*` queries. */

export type AlertRow = typeof alerts.$inferSelect;
export type AlertEventRow = typeof alertEvents.$inferSelect;

export interface AlertWriteInput {
  userId: string;
  type: AlertType;
  itemId: bigint | null;
  watchlistId: string | null;
  window: Window;
  params: AlertParams;
  cooldownHours: number;
  enabled: boolean;
}

export async function listAlertsForUser(db: DbExecutor, userId: string): Promise<AlertRow[]> {
  return db
    .select()
    .from(alerts)
    .where(eq(alerts.userId, userId))
    .orderBy(desc(alerts.createdAt), desc(alerts.id));
}

export async function getAlertForUser(
  db: DbExecutor,
  userId: string,
  alertId: string,
): Promise<AlertRow | null> {
  const [row] = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId)));
  return row ?? null;
}

export async function countAlertsForUser(db: DbExecutor, userId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(eq(alerts.userId, userId));
  return row?.count ?? 0;
}

export async function insertAlert(db: DbExecutor, input: AlertWriteInput): Promise<AlertRow> {
  const [row] = await db.insert(alerts).values(input).returning();
  if (row === undefined) throw new Error('insertAlert returned no row');
  return row;
}

export interface AlertPatch {
  type?: AlertType;
  itemId?: bigint | null;
  watchlistId?: string | null;
  window?: Window;
  params?: AlertParams;
  cooldownHours?: number;
  enabled?: boolean;
}

export async function updateAlert(
  db: DbExecutor,
  userId: string,
  alertId: string,
  patch: AlertPatch,
): Promise<AlertRow | null> {
  const [row] = await db
    .update(alerts)
    .set(patch)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId)))
    .returning();
  return row ?? null;
}

export async function deleteAlert(
  db: DbExecutor,
  userId: string,
  alertId: string,
): Promise<boolean> {
  const rows = await db
    .delete(alerts)
    .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId)))
    .returning({ id: alerts.id });
  return rows.length > 0;
}

/** Events are newest-first; `beforeId` is the last id of the previous page. */
export interface AlertEventWithMeta {
  event: AlertEventRow;
  alertType: AlertType;
  window: Window;
  item: { id: bigint; source: Source; displayName: string; url: string };
}

export async function listAlertEventsForUser(
  db: DbExecutor,
  userId: string,
  options: { beforeId?: bigint; limit: number },
): Promise<AlertEventWithMeta[]> {
  const where =
    options.beforeId === undefined
      ? eq(alerts.userId, userId)
      : and(eq(alerts.userId, userId), lt(alertEvents.id, options.beforeId));
  return db
    .select({
      event: alertEvents,
      alertType: alerts.type,
      window: alerts.window,
      itemId: items.id,
      itemSource: items.source,
      itemDisplayName: items.displayName,
      itemUrl: items.url,
    })
    .from(alertEvents)
    .innerJoin(alerts, eq(alerts.id, alertEvents.alertId))
    .innerJoin(items, eq(items.id, alertEvents.itemId))
    .where(where)
    .orderBy(desc(alertEvents.id))
    .limit(options.limit)
    .then((rows) =>
      rows.map((row) => ({
        event: row.event,
        alertType: row.alertType,
        window: row.window,
        item: {
          id: row.itemId,
          source: row.itemSource,
          displayName: row.itemDisplayName,
          url: row.itemUrl,
        },
      })),
    );
}

/** Every enabled rule; the evaluator narrows by source and target in memory. */
export async function listEnabledAlerts(db: DbExecutor): Promise<AlertRow[]> {
  return db.select().from(alerts).where(eq(alerts.enabled, true));
}

export interface WatchlistAlertItem {
  watchlistId: string;
  itemId: bigint;
}

export async function listWatchlistItemsForWatchlists(
  db: DbExecutor,
  watchlistIds: readonly string[],
  source: Source,
): Promise<WatchlistAlertItem[]> {
  if (watchlistIds.length === 0) return [];
  return db
    .select({ watchlistId: watchlistItems.watchlistId, itemId: watchlistItems.itemId })
    .from(watchlistItems)
    .innerJoin(items, eq(items.id, watchlistItems.itemId))
    .where(
      and(
        inArray(watchlistItems.watchlistId, [...watchlistIds]),
        eq(items.source, source),
        eq(items.isDeleted, false),
      ),
    );
}

export interface AlertItemRow {
  id: bigint;
  source: Source;
  displayName: string;
  url: string;
  language: string | null;
  primaryMetric: string;
  latestMetrics: Partial<Record<string, number>>;
  isDeleted: boolean;
}

export async function loadAlertItems(
  db: DbExecutor,
  ids: readonly bigint[],
): Promise<Map<bigint, AlertItemRow>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: items.id,
      source: items.source,
      displayName: items.displayName,
      url: items.url,
      language: items.language,
      primaryMetric: items.primaryMetric,
      latestMetrics: items.latestMetrics,
      isDeleted: items.isDeleted,
    })
    .from(items)
    .where(inArray(items.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}
