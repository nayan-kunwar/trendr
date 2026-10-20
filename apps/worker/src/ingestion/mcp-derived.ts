import { and, eq, gte, inArray, notLike } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { Source } from '@trendr/core';
import { dailyMetrics, itemAliases, items, type Db } from '@trendr/db';
import type { AliasTargetKey, DerivedMetrics, DiscoveredRef } from '@trendr/sources';

/**
 * Spec §7.3.6 — MCP snapshots are derived: they copy the latest stars of the
 * linked GitHub repository and the daily downloads of the linked npm/PyPI
 * package. The query lives in the worker (which owns Postgres) and is injected
 * into the adapter through `AdapterContext`, keeping `@trendr/sources` free of
 * database dependencies.
 */

const DAY_MS = 86_400_000;
const DEFAULT_DAILY_DAYS = 3;

export async function loadMcpDerivedMetrics(
  db: Db,
  refs: readonly DiscoveredRef[],
  options: { days?: number } = {},
): Promise<Map<string, DerivedMetrics>> {
  const result = new Map<string, DerivedMetrics>();
  const externalByItemId = new Map<string, string>();
  for (const ref of refs) {
    if (ref.itemId !== undefined) externalByItemId.set(ref.itemId.toString(), ref.externalId);
  }
  if (externalByItemId.size === 0) return result;

  const target = alias(items, 'alias_target');
  const rows = await db
    .select({
      itemId: itemAliases.itemId,
      aliasItemId: itemAliases.aliasItemId,
      source: target.source,
      latestMetrics: target.latestMetrics,
    })
    .from(itemAliases)
    .innerJoin(target, eq(target.id, itemAliases.aliasItemId))
    .where(
      and(
        inArray(
          itemAliases.itemId,
          [...externalByItemId.keys()].map((id) => BigInt(id)),
        ),
        eq(target.isDeleted, false),
      ),
    );

  const starsByItem = new Map<string, { value: number; aliasItemId: bigint }>();
  const downloadsByItem = new Map<string, { value: number; aliasItemId: bigint }>();
  const bestAliasByItem = new Map<string, bigint>();

  for (const row of rows) {
    const itemKey = row.itemId.toString();
    const latest = row.latestMetrics;
    if (row.source === 'github') {
      const stars = numberValue(latest.stars);
      if (stars === null) continue;
      const current = starsByItem.get(itemKey);
      if (current === undefined || stars > current.value) {
        starsByItem.set(itemKey, { value: stars, aliasItemId: row.aliasItemId });
      }
    } else if (row.source === 'npm' || row.source === 'pypi') {
      const downloads = numberValue(latest.downloads) ?? 0;
      const current = downloadsByItem.get(itemKey);
      if (current === undefined || downloads > current.value) {
        downloadsByItem.set(itemKey, {
          value: downloads,
          aliasItemId: row.aliasItemId,
        });
        bestAliasByItem.set(itemKey, row.aliasItemId);
      }
    }
  }

  const downloadAliasIds = [...new Set([...bestAliasByItem.values()].map((id) => id.toString()))];
  const dailyByAlias = new Map<string, { day: string; value: number }[]>();
  if (downloadAliasIds.length > 0) {
    const cutoff = isoDay(new Date(Date.now() - (options.days ?? DEFAULT_DAILY_DAYS) * DAY_MS));
    const daily = await db
      .select({
        itemId: dailyMetrics.itemId,
        day: dailyMetrics.day,
        value: dailyMetrics.value,
      })
      .from(dailyMetrics)
      .where(
        and(
          inArray(
            dailyMetrics.itemId,
            downloadAliasIds.map((id) => BigInt(id)),
          ),
          eq(dailyMetrics.metric, 'downloads'),
          gte(dailyMetrics.day, cutoff),
        ),
      )
      .orderBy(dailyMetrics.itemId, dailyMetrics.day);

    for (const row of daily) {
      const key = row.itemId.toString();
      const points = dailyByAlias.get(key) ?? [];
      points.push({ day: row.day, value: row.value });
      dailyByAlias.set(key, points);
    }
  }

  for (const [itemKey, externalId] of externalByItemId) {
    const stars = starsByItem.get(itemKey);
    const downloads = downloadsByItem.get(itemKey);
    const aliasItemId = bestAliasByItem.get(itemKey);
    const daily = aliasItemId === undefined ? [] : (dailyByAlias.get(aliasItemId.toString()) ?? []);
    const derivedDaily = daily.map((point) => ({
      metric: 'downloads' as const,
      day: point.day,
      value: point.value,
    }));
    const newestDownload =
      downloads !== undefined && derivedDaily.length > 0
        ? (derivedDaily[derivedDaily.length - 1]?.value ?? downloads.value)
        : downloads?.value;
    const latest: Partial<Record<'stars' | 'downloads', number>> = {};
    if (stars !== undefined) latest.stars = stars.value;
    if (newestDownload !== undefined) latest.downloads = newestDownload;
    if (latest.stars === undefined && latest.downloads === undefined && derivedDaily.length === 0) {
      continue;
    }
    result.set(externalId, { latest, daily: derivedDaily });
  }

  return result;
}

/**
 * Spec §7.3.6 — GitHub/npm fallback hits already represented by a registry
 * item must not become a second MCP item. Registry items are the canonical
 * (non-`github:`/`npm:`) rows; fallback rows never suppress each other.
 */
export async function findLinkedMcpAliasTargets(
  db: Db,
  targets: readonly AliasTargetKey[],
): Promise<Set<string>> {
  const linked = new Set<string>();
  if (targets.length === 0) return linked;

  const bySource = new Map<Source, string[]>();
  for (const targetKey of targets) {
    const ids = bySource.get(targetKey.source) ?? [];
    ids.push(targetKey.externalId);
    bySource.set(targetKey.source, ids);
  }

  const target = alias(items, 'alias_target');
  const owner = alias(items, 'mcp_owner');
  for (const [source, externalIds] of bySource) {
    const rows = await db
      .select({ source: target.source, externalId: target.externalId })
      .from(itemAliases)
      .innerJoin(target, eq(target.id, itemAliases.aliasItemId))
      .innerJoin(owner, eq(owner.id, itemAliases.itemId))
      .where(
        and(
          eq(owner.source, 'mcp'),
          eq(owner.isDeleted, false),
          notLike(owner.externalId, 'github:%'),
          notLike(owner.externalId, 'npm:%'),
          eq(target.source, source),
          inArray(target.externalId, externalIds),
        ),
      );
    for (const row of rows) linked.add(`${row.source}:${row.externalId}`);
  }
  return linked;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
