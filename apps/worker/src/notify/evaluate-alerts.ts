import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  jobId,
  parseAlertParams,
  redisKeys,
  type Metric,
  type Source,
  type Window,
} from '@trendr/core';
import {
  alertEvents,
  getRun,
  listEnabledAlerts,
  listWatchlistItemsForWatchlists,
  loadAlertItems,
  scores,
  topics,
  itemTopics,
  type AlertItemRow,
  type AlertRow,
  type Db,
} from '@trendr/db';
import type { Logger } from '@trendr/logger';

import { alertsFiredTotal } from '../metrics.js';

/**
 * Spec §13.1/task 7.3 — evaluate enabled alert rules after one scoring run.
 * Insertion is protected by `alert_events.dedupe_key`, so a BullMQ retry of
 * this processor cannot fire the same rule twice inside a cooldown bucket.
 */

export interface AlertNotifyQueue {
  add(
    name: string,
    data: {
      type: 'send-alert-email';
      alertEventId: string;
      alertEventIds?: string[];
    },
    options?: { jobId?: string },
  ): Promise<unknown>;
}

export interface EvaluateAlertsDeps {
  db: Db;
  redis: Redis;
  notifyQueue?: AlertNotifyQueue;
  now?: () => Date;
  logger?: Logger;
}

export interface EvaluateAlertsResult {
  /** Rule/item pairs that matched, including duplicates suppressed by dedupe. */
  matched: number;
  /** Newly inserted `alert_events` rows. */
  inserted: number;
  /** Email jobs enqueued (batched users count once). */
  emailJobs: number;
}

interface EventDraft {
  alert: AlertRow;
  item: AlertItemRow;
  payload: Record<string, unknown>;
}

function eventItem(item: AlertItemRow): Record<string, unknown> {
  return {
    id: item.id.toString(),
    source: item.source,
    displayName: item.displayName,
    url: item.url,
    language: item.language,
    primaryMetric: item.primaryMetric,
  };
}

function isCooling(alert: AlertRow, now: Date): boolean {
  if (alert.lastTriggeredAt === null) return false;
  return alert.lastTriggeredAt.getTime() > now.getTime() - alert.cooldownHours * 3_600_000;
}

function cooldownBucket(startedAt: Date, cooldownHours: number): number {
  return Math.floor(startedAt.getTime() / 3_600_000 / cooldownHours);
}

function scoreKey(itemId: bigint, window: Window): string {
  return `${itemId.toString()}:${window}`;
}

async function velocityDrafts(
  deps: EvaluateAlertsDeps,
  active: readonly AlertRow[],
  candidates: ReadonlyMap<string, readonly bigint[]>,
  itemMap: ReadonlyMap<bigint, AlertItemRow>,
  runId: bigint,
): Promise<EventDraft[]> {
  const windowIds = new Map<Window, Set<bigint>>();
  for (const alert of active) {
    if (alert.type !== 'velocity_spike') continue;
    let ids = windowIds.get(alert.window);
    if (ids === undefined) {
      ids = new Set();
      windowIds.set(alert.window, ids);
    }
    for (const id of candidates.get(alert.id) ?? []) ids.add(id);
  }
  if (windowIds.size === 0) return [];

  const current = new Map<string, { delta: number; percentile: number; computedAt: Date }>();
  const trailing = new Map<string, Map<string, number>>();
  for (const [window, ids] of windowIds) {
    if (ids.size === 0) continue;
    const rows = await deps.db
      .select({
        itemId: scores.itemId,
        delta: scores.delta,
        percentile: scores.percentile,
        computedAt: scores.computedAt,
      })
      .from(scores)
      .where(
        and(eq(scores.runId, runId), eq(scores.window, window), inArray(scores.itemId, [...ids])),
      );
    let currentComputedAt: Date | null = null;
    for (const row of rows) {
      current.set(scoreKey(row.itemId, window), row);
      if (currentComputedAt === null || row.computedAt > currentComputedAt) {
        currentComputedAt = row.computedAt;
      }
    }
    if (currentComputedAt === null) continue;

    const dayStart = new Date(
      Date.UTC(
        currentComputedAt.getUTCFullYear(),
        currentComputedAt.getUTCMonth(),
        currentComputedAt.getUTCDate(),
      ),
    );
    const trailingRows = await trailingDeltas(deps.db, window, [...ids], dayStart);
    for (const [itemId, days] of trailingRows) {
      trailing.set(scoreKey(itemId, window), days);
    }
  }

  const drafts: EventDraft[] = [];
  for (const alert of active) {
    if (alert.type !== 'velocity_spike') continue;
    const params = parseAlertParams(alert.type, alert.params);
    if (!('minPercentile' in params)) continue;
    for (const itemId of candidates.get(alert.id) ?? []) {
      const item = itemMap.get(itemId);
      const currentScore = current.get(scoreKey(itemId, alert.window));
      if (item === undefined || currentScore === undefined) continue;
      if (currentScore.percentile < params.minPercentile) continue;
      if (currentScore.delta <= 0) continue;

      const days = trailing.get(scoreKey(itemId, alert.window)) ?? new Map<string, number>();
      const average = averagePreviousDays(
        days,
        new Date(
          Date.UTC(
            currentScore.computedAt.getUTCFullYear(),
            currentScore.computedAt.getUTCMonth(),
            currentScore.computedAt.getUTCDate(),
          ),
        ),
      );
      if (currentScore.delta < params.minDeltaMultiple * average) continue;

      drafts.push({
        alert,
        item,
        payload: {
          alertType: alert.type,
          window: alert.window,
          item: eventItem(item),
          delta: currentScore.delta,
          percentile: currentScore.percentile,
          trailingAvgDelta: average,
          minPercentile: params.minPercentile,
          minDeltaMultiple: params.minDeltaMultiple,
        },
      });
    }
  }
  return drafts;
}

const DAY_MS = 86_400_000;

async function trailingDeltas(
  db: Db,
  window: Window,
  ids: readonly bigint[],
  currentDayStart: Date,
): Promise<Map<bigint, Map<string, number>>> {
  if (ids.length === 0) return new Map();
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await db.execute<{ itemId: string; day: string; delta: number }>(sql`
    SELECT x.item_id::text AS "itemId", to_char(x.day, 'YYYY-MM-DD') AS day, x.delta
    FROM (
      SELECT s.item_id, (s.computed_at AT TIME ZONE 'UTC')::date AS day, s.delta,
             row_number() OVER (
               PARTITION BY s.item_id, (s.computed_at AT TIME ZONE 'UTC')::date
               ORDER BY s.computed_at DESC
             ) AS rn
      FROM scores s
      WHERE s.window = ${window}
        AND s.item_id IN (${idList})
        AND s.computed_at < ${currentDayStart}
        AND s.computed_at >= ${new Date(currentDayStart.getTime() - 4 * DAY_MS)}
    ) x
    WHERE x.rn = 1`);
  const byItem = new Map<bigint, Map<string, number>>();
  for (const row of result.rows) {
    const itemId = BigInt(row.itemId);
    let days = byItem.get(itemId);
    if (days === undefined) {
      days = new Map();
      byItem.set(itemId, days);
    }
    days.set(row.day, row.delta);
  }
  return byItem;
}

/** Mean delta of the previous four complete UTC days; a missing day counts as 0. */
function averagePreviousDays(days: ReadonlyMap<string, number>, currentDayStart: Date): number {
  let sum = 0;
  for (let offset = 1; offset <= 4; offset += 1) {
    const day = new Date(currentDayStart.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    sum += days.get(day) ?? 0;
  }
  return sum / 4;
}

async function thresholdDrafts(
  deps: EvaluateAlertsDeps,
  active: readonly AlertRow[],
  candidates: ReadonlyMap<string, readonly bigint[]>,
  itemMap: ReadonlyMap<bigint, AlertItemRow>,
): Promise<EventDraft[]> {
  const idsByMetric = new Map<Metric, Set<bigint>>();
  for (const alert of active) {
    if (alert.type !== 'threshold_crossed') continue;
    const params = parseAlertParams(alert.type, alert.params);
    if (!('metric' in params)) continue;
    let ids = idsByMetric.get(params.metric);
    if (ids === undefined) {
      ids = new Set();
      idsByMetric.set(params.metric, ids);
    }
    for (const id of candidates.get(alert.id) ?? []) ids.add(id);
  }
  if (idsByMetric.size === 0) return [];

  const latest = new Map<string, { current: number; previous: number }>();
  for (const [metric, ids] of idsByMetric) {
    if (ids.size === 0) continue;
    const idList = sql.join(
      [...ids].map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await deps.db.execute<{
      itemId: string;
      value: string;
      rn: string;
    }>(sql`
      SELECT x.item_id::text AS "itemId", x.value, x.rn
      FROM (
        SELECT s.item_id, s.value,
               row_number() OVER (PARTITION BY s.item_id ORDER BY s.captured_at DESC) AS rn
        FROM snapshots s
        WHERE s.metric = ${metric} AND s.item_id IN (${idList})
      ) x
      WHERE x.rn <= 2`);
    const byItem = new Map<string, { first?: number; second?: number }>();
    for (const row of result.rows) {
      let pair = byItem.get(row.itemId);
      if (pair === undefined) {
        pair = {};
        byItem.set(row.itemId, pair);
      }
      if (Number(row.rn) === 1) pair.first = Number(row.value);
      if (Number(row.rn) === 2) pair.second = Number(row.value);
    }
    for (const [itemId, pair] of byItem) {
      if (pair.first === undefined || pair.second === undefined) continue;
      latest.set(`${itemId}:${metric}`, { current: pair.first, previous: pair.second });
    }
  }

  const drafts: EventDraft[] = [];
  for (const alert of active) {
    if (alert.type !== 'threshold_crossed') continue;
    const params = parseAlertParams(alert.type, alert.params);
    if (!('metric' in params)) continue;
    for (const itemId of candidates.get(alert.id) ?? []) {
      const item = itemMap.get(itemId);
      const pair = latest.get(`${itemId.toString()}:${params.metric}`);
      if (item === undefined || pair === undefined) continue;
      if (!(pair.previous < params.value && pair.current >= params.value)) continue;
      drafts.push({
        alert,
        item,
        payload: {
          alertType: alert.type,
          window: alert.window,
          item: eventItem(item),
          metric: params.metric,
          value: params.value,
          previousValue: pair.previous,
          currentValue: pair.current,
        },
      });
    }
  }
  return drafts;
}

interface AliasRow {
  itemId: bigint;
  aliasItemId: bigint;
  aliasName: string;
  aliasUrl: string;
  aliasSource: Source;
  relation: string;
  createdAt: Date;
}

async function aliasDrafts(
  deps: EvaluateAlertsDeps,
  active: readonly AlertRow[],
  candidates: ReadonlyMap<string, readonly bigint[]>,
  itemMap: ReadonlyMap<bigint, AlertItemRow>,
): Promise<EventDraft[]> {
  const aliasAlerts = active.filter((alert) => alert.type === 'new_alias');
  if (aliasAlerts.length === 0) return [];
  const ids = new Set<bigint>();
  let minSince = new Date();
  for (const alert of aliasAlerts) {
    for (const id of candidates.get(alert.id) ?? []) ids.add(id);
    const since = alert.lastTriggeredAt ?? alert.createdAt;
    if (since < minSince) minSince = since;
  }
  if (ids.size === 0) return [];

  const idList = sql.join(
    [...ids].map((id) => sql`${id}`),
    sql`, `,
  );
  const result = await deps.db.execute<{
    itemId: string;
    aliasItemId: string;
    aliasName: string;
    aliasUrl: string;
    aliasSource: Source;
    relation: string;
    createdAt: string;
  }>(sql`
    SELECT a.item_id::text AS "itemId", a.alias_item_id::text AS "aliasItemId",
           ai.display_name AS "aliasName", ai.url AS "aliasUrl", ai.source AS "aliasSource",
           a.relation, a.created_at AS "createdAt"
    FROM item_aliases a
    JOIN items ai ON ai.id = a.alias_item_id
    WHERE a.created_at > ${minSince}
      AND (a.item_id IN (${idList}) OR a.alias_item_id IN (${idList}))`);

  const drafts: EventDraft[] = [];
  for (const alert of aliasAlerts) {
    const since = alert.lastTriggeredAt ?? alert.createdAt;
    for (const targetId of candidates.get(alert.id) ?? []) {
      const item = itemMap.get(targetId);
      if (item === undefined) continue;
      const involved: AliasRow[] = result.rows
        .filter(
          (row) =>
            (BigInt(row.itemId) === targetId || BigInt(row.aliasItemId) === targetId) &&
            new Date(row.createdAt) > since,
        )
        .map((row) => ({
          itemId: BigInt(row.itemId),
          aliasItemId: BigInt(row.aliasItemId),
          aliasName: row.aliasName,
          aliasUrl: row.aliasUrl,
          aliasSource: row.aliasSource,
          relation: row.relation,
          createdAt: new Date(row.createdAt),
        }));
      if (involved.length === 0) continue;
      drafts.push({
        alert,
        item,
        payload: {
          alertType: alert.type,
          window: alert.window,
          item: eventItem(item),
          aliases: involved.slice(0, 10).map((alias) => ({
            itemId: alias.itemId.toString(),
            aliasItemId: alias.aliasItemId.toString(),
            name: alias.aliasName,
            url: alias.aliasUrl,
            source: alias.aliasSource,
            relation: alias.relation,
            createdAt: alias.createdAt.toISOString(),
          })),
        },
      });
    }
  }
  return drafts;
}

async function rankDrafts(
  deps: EvaluateAlertsDeps,
  active: readonly AlertRow[],
  source: Source,
  runId: bigint,
): Promise<EventDraft[]> {
  const rankAlerts = active.filter((alert) => alert.type === 'rank_entered');
  if (rankAlerts.length === 0) return [];

  const drafts: EventDraft[] = [];
  for (const alert of rankAlerts) {
    const params = parseAlertParams(alert.type, alert.params);
    if (!('topN' in params)) continue;
    if (params.scope !== 'all' && params.scope !== source) continue;

    const currentKey = redisKeys.leaderboard(params.scope, alert.window, '_all');
    const previousKey = redisKeys.leaderboardPrevious(params.scope, alert.window, '_all', runId);
    const currentIds = await deps.redis.zrevrange(currentKey, 0, -1);
    if (currentIds.length === 0) continue;
    const previousIds =
      (await deps.redis.exists(previousKey)) === 0
        ? []
        : await deps.redis.zrevrange(previousKey, 0, -1);

    const filterIds = [...new Set([...currentIds, ...previousIds])].map((id) => BigInt(id));
    const items = await loadAlertItems(deps.db, filterIds);
    const topicMembership = new Map<bigint, Set<string>>();
    if (params.topic !== undefined) {
      const rows = await deps.db
        .select({ itemId: itemTopics.itemId, slug: topics.slug })
        .from(itemTopics)
        .innerJoin(topics, eq(topics.id, itemTopics.topicId))
        .where(inArray(itemTopics.itemId, filterIds));
      for (const row of rows) {
        let set = topicMembership.get(row.itemId);
        if (set === undefined) {
          set = new Set();
          topicMembership.set(row.itemId, set);
        }
        set.add(row.slug);
      }
    }

    const keep = (rawId: string): boolean => {
      const item = items.get(BigInt(rawId));
      if (item === undefined || item.isDeleted) return false;
      if (params.lang !== undefined) {
        if (item.language?.toLowerCase() !== params.lang.toLowerCase()) return false;
      }
      if (params.topic !== undefined) {
        if (!topicMembership.get(item.id)?.has(params.topic)) return false;
      }
      return true;
    };

    const current = currentIds.filter(keep);
    const previous = previousIds.filter(keep);
    const previousRank = new Map<string, number>();
    previous.forEach((id, index) => {
      previousRank.set(id, index + 1);
    });

    current.forEach((id, index) => {
      const rank = index + 1;
      if (rank > params.topN) return;
      const before = previousRank.get(id);
      if (before !== undefined && before <= params.topN) return;
      const item = items.get(BigInt(id));
      if (item === undefined) return;
      drafts.push({
        alert,
        item,
        payload: {
          alertType: alert.type,
          window: alert.window,
          item: eventItem(item),
          rank,
          previousRank: before ?? null,
          scope: params.scope,
          lang: params.lang ?? null,
          topic: params.topic ?? null,
        },
      });
    });
  }
  return drafts;
}

export async function evaluateAlerts(
  deps: EvaluateAlertsDeps,
  input: { scoreRunId: string; source: Source },
): Promise<EvaluateAlertsResult> {
  let runId: bigint;
  try {
    runId = BigInt(input.scoreRunId);
  } catch {
    throw new Error(`invalid scoreRunId: ${input.scoreRunId}`);
  }
  const run = await getRun(deps.db, runId);
  if (run === null) throw new Error(`scoring run ${input.scoreRunId} not found`);
  if (run.jobType !== 'score' || run.source !== input.source) {
    throw new Error(`run ${input.scoreRunId} is not a ${input.source} scoring run`);
  }

  const now = deps.now?.() ?? new Date();
  const all = await listEnabledAlerts(deps.db);
  const active = all.filter((alert) => !isCooling(alert, now));

  const watchlistIds = [
    ...new Set(active.map((alert) => alert.watchlistId).filter((id): id is string => id !== null)),
  ];
  const watchlistRows = await listWatchlistItemsForWatchlists(deps.db, watchlistIds, input.source);
  const byWatchlist = new Map<string, bigint[]>();
  for (const row of watchlistRows) {
    const list = byWatchlist.get(row.watchlistId) ?? [];
    list.push(row.itemId);
    byWatchlist.set(row.watchlistId, list);
  }

  const candidates = new Map<string, readonly bigint[]>();
  const candidateIds = new Set<bigint>();
  for (const alert of active) {
    if (alert.type === 'rank_entered') continue;
    const ids =
      alert.itemId !== null
        ? [alert.itemId]
        : alert.watchlistId !== null
          ? (byWatchlist.get(alert.watchlistId) ?? [])
          : [];
    if (ids.length === 0) continue;
    candidates.set(alert.id, ids);
    for (const id of ids) candidateIds.add(id);
  }

  const itemMap = await loadAlertItems(deps.db, [...candidateIds]);
  const filteredCandidates = new Map<string, readonly bigint[]>();
  for (const alert of active) {
    const ids = (candidates.get(alert.id) ?? []).filter((id) => {
      const item = itemMap.get(id);
      return item !== undefined && !item.isDeleted && item.source === input.source;
    });
    if (ids.length > 0) filteredCandidates.set(alert.id, ids);
  }

  const rankedAlerts = active.filter((alert) => alert.type === 'rank_entered');
  const evaluable = active.filter(
    (alert) => alert.type === 'rank_entered' || filteredCandidates.has(alert.id),
  );

  const drafts: EventDraft[] = [
    ...(await velocityDrafts(deps, evaluable, filteredCandidates, itemMap, runId)),
    ...(await thresholdDrafts(deps, evaluable, filteredCandidates, itemMap)),
    ...(await aliasDrafts(deps, evaluable, filteredCandidates, itemMap)),
    ...(await rankDrafts(deps, rankedAlerts.length > 0 ? rankedAlerts : [], input.source, runId)),
  ];

  const unique = new Map<string, EventDraft>();
  for (const draft of drafts) {
    const key = `${draft.alert.id}:${draft.item.id.toString()}:${draft.alert.window}`;
    if (!unique.has(key)) unique.set(key, draft);
  }

  const bucketByCooldown = new Map<number, number>();
  const rows = [...unique.values()].map((draft) => {
    const hours = draft.alert.cooldownHours;
    let bucket = bucketByCooldown.get(hours);
    if (bucket === undefined) {
      bucket = cooldownBucket(run.startedAt, hours);
      bucketByCooldown.set(hours, bucket);
    }
    return {
      alertId: draft.alert.id,
      itemId: draft.item.id,
      scoreRunId: runId,
      dedupeKey: `${draft.alert.id}:${draft.item.id.toString()}:${draft.alert.window}:${bucket}`,
      payload: draft.payload,
    };
  });

  if (rows.length === 0) {
    return { matched: 0, inserted: 0, emailJobs: 0 };
  }

  const inserted = await deps.db
    .insert(alertEvents)
    .values(rows)
    .onConflictDoNothing({ target: alertEvents.dedupeKey })
    .returning({ id: alertEvents.id, alertId: alertEvents.alertId });

  const alertById = new Map(active.map((alert) => [alert.id, alert]));
  return finalize(deps, inserted, alertById, now);
}

async function finalize(
  deps: EvaluateAlertsDeps,
  inserted: readonly { id: bigint; alertId: string }[],
  alertById: ReadonlyMap<string, AlertRow>,
  now: Date,
): Promise<EvaluateAlertsResult> {
  if (inserted.length === 0) return { matched: 0, inserted: 0, emailJobs: 0 };

  for (const row of inserted) {
    const alert = alertById.get(row.alertId);
    if (alert !== undefined) alertsFiredTotal.inc({ type: alert.type });
  }

  const touched = [...new Set(inserted.map((row) => row.alertId))];
  await deps.db.execute(sql`
    UPDATE alerts SET last_triggered_at = ${now}
    WHERE id IN (${sql.join(
      touched.map((id) => sql`${id}`),
      sql`, `,
    )})`);

  let emailJobs = 0;
  if (deps.notifyQueue !== undefined) {
    const byUser = new Map<string, string[]>();
    for (const row of inserted) {
      const alert = alertById.get(row.alertId);
      if (alert === undefined) continue;
      const list = byUser.get(alert.userId) ?? [];
      list.push(row.id.toString());
      byUser.set(alert.userId, list);
    }
    for (const ids of byUser.values()) {
      if (ids.length > 5) {
        const first = ids[0];
        if (first === undefined) continue;
        await deps.notifyQueue.add(
          'send-alert-email',
          { type: 'send-alert-email', alertEventId: first, alertEventIds: ids },
          { jobId: jobId.alertEmail(first) },
        );
        emailJobs += 1;
      } else {
        for (const id of ids) {
          await deps.notifyQueue.add(
            'send-alert-email',
            { type: 'send-alert-email', alertEventId: id },
            { jobId: jobId.alertEmail(id) },
          );
          emailJobs += 1;
        }
      }
    }
  }

  return { matched: inserted.length, inserted: inserted.length, emailJobs };
}
