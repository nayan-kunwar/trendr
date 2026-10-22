import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import {
  METRICS,
  METRIC_KIND,
  NotFoundError,
  paramsFor,
  redisKeys,
  type Metric,
  type ScoringParams,
  type Source,
  type Window,
} from '@trendr/core';
import {
  findItemByNaturalKey,
  getCurrentScoreRun,
  getItemById,
  loadItemAliasLinks,
  loadItemCurrentScores,
  loadItemScoreForRun,
  loadItemScoreHistory,
  loadItemTopics,
} from '@trendr/db';

import type { CacheKind } from '../plugins/cache.js';
import { CACHE_CONTROL } from '../plugins/etag.js';
import { IdParam, MAX_ITEM_ID } from '../schemas/common.js';
import {
  HistoryQuery,
  HistoryResponse,
  ItemAliasesResponse,
  ItemDetailResponse,
  LookupQuery,
  ScoreExplainQuery,
  ScoreExplainResponse,
  ScoresQuery,
  ScoresResponse,
  type HistoryBody,
  type HistoryQueryInput,
  type ItemAliasesBody,
  type ItemDetailBody,
  type ItemScoreDto,
  type ScoreExplainBody,
  type ScoresBody,
  type ScoresQueryInput,
} from '../schemas/items.js';
import { loadMetricSeries, truncateToGranularity } from '../services/item.service.js';

/**
 * Spec §10.1/§10.4 — the item endpoints: detail, lookup (302), history
 * (hour/day), score history (retention-bounded), score-explain and aliases.
 * Detail is cached under `item:{id}` (300 s) and history under
 * `hist:{id}:{metric}:{granularity}:{rangeKey}` (900 s, spec §9.1); every
 * response gets the §9.4 body-hash ETag from the etag plugin.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const ITEM_DETAIL_TTL_SECONDS = 300;
const HISTORY_TTL_SECONDS = 900;

export interface ItemRoutesOptions {
  /** Scores-retention bounds (env: SCORES_HOURLY_RETENTION_HOURS / SCORES_DAILY_RETENTION_DAYS). */
  scoresRetention?: { hourlyHours: number; dailyDays: number };
}

export const DEFAULT_SCORES_RETENTION = { hourlyHours: 48, dailyDays: 365 } as const;

/** `:id` is validated by `IdParam`; anything beyond bigint range cannot exist. */
export function parseItemId(raw: string): bigint {
  const id = BigInt(raw);
  if (id > MAX_ITEM_ID) {
    throw new NotFoundError(`Item ${raw} not found`);
  }
  return id;
}

/** `hist:…:{rangeKey}` (spec §9.1): the truncated span, e.g. `720h` or `30d`. */
export function historyRangeKey(from: Date, to: Date, granularity: 'hour' | 'day'): string {
  const unit = granularity === 'hour' ? HOUR_MS : DAY_MS;
  const units = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / unit));
  return `${units}${granularity === 'hour' ? 'h' : 'd'}`;
}

/** Read-through when Redis/cache is wired (tests may build the app without it). */
function cached<T>(
  app: FastifyInstance,
  key: string,
  ttlSec: number,
  load: () => Promise<T>,
  kind: CacheKind,
): Promise<T> {
  if (!app.hasDecorator('cache')) {
    return load();
  }
  return app.cache.readThrough(key, ttlSec, load, kind);
}

async function readItemDetail(app: FastifyInstance, id: bigint): Promise<ItemDetailBody> {
  const db = app.db;
  const item = await getItemById(db, id);
  if (item === null) {
    throw new NotFoundError(`Item ${id} not found`);
  }
  const [topics, aliasLinks, scoreRows] = await Promise.all([
    loadItemTopics(db, id),
    loadItemAliasLinks(db, id),
    loadItemCurrentScores(db, id),
  ]);

  // `latest_metrics` is a partial record; keep only the known §5 metrics so the
  // response can never carry a key the wire schema rejects.
  const latestMetrics: Partial<Record<Metric, number>> = {};
  for (const metric of METRICS) {
    const value = item.latestMetrics[metric];
    if (typeof value === 'number') {
      latestMetrics[metric] = value;
    }
  }

  const scores: Record<Window, ItemScoreDto | null> = { '24h': null, '7d': null, '30d': null };
  for (const row of scoreRows) {
    scores[row.window] = {
      rankSource: row.rankSource,
      rankAll: row.rankAll,
      delta: row.delta,
      relGrowth: row.relGrowth,
      finalScore: row.finalScore,
      zScore: row.zScore,
      percentile: row.percentile,
      flags: row.flags,
    };
  }

  return {
    id: String(item.id),
    source: item.source,
    kind: item.kind,
    externalId: item.externalId,
    name: item.name,
    displayName: item.displayName,
    description: item.description,
    url: item.url,
    homepage: item.homepage,
    language: item.language,
    license: item.license,
    owner: item.owner,
    topics,
    primaryMetric: item.primaryMetric,
    latestMetrics,
    tier: item.tier,
    flags: item.flags,
    upstreamCreatedAt: item.upstreamCreatedAt?.toISOString() ?? null,
    firstSeenAt: item.firstSeenAt.toISOString(),
    lastSnapshotAt: item.lastSnapshotAt?.toISOString() ?? null,
    scores,
    aliases: aliasLinks
      .filter((link) => link.direction === 'outgoing')
      .map((link) => ({
        id: String(link.id),
        source: link.source,
        displayName: link.displayName,
        relation: link.relation,
        confidence: link.confidence,
      })),
    metadata: item.metadata,
  };
}

async function readHistory(
  app: FastifyInstance,
  id: bigint,
  query: HistoryQueryInput,
): Promise<HistoryBody> {
  const db = app.db;
  const item = await getItemById(db, id);
  if (item === null) {
    throw new NotFoundError(`Item ${id} not found`);
  }
  const metric = query.metric ?? item.primaryMetric;
  const kind = METRIC_KIND[metric];
  const granularity = query.granularity;
  const to = query.to === undefined ? new Date() : new Date(query.to);
  const from =
    query.from === undefined ? new Date(to.getTime() - 30 * DAY_MS) : new Date(query.from);
  // Both the query range and the cache key sit on the granularity grid, so
  // requests in the same hour/day share one cached series without missing
  // bucket points.
  const fromT = truncateToGranularity(from, granularity);
  const toT = truncateToGranularity(to, granularity);
  const key = redisKeys.history(id, metric, granularity, historyRangeKey(fromT, toT, granularity));

  return cached(
    app,
    key,
    HISTORY_TTL_SECONDS,
    async () => {
      const points = await loadMetricSeries(db, id, metric, granularity, fromT, toT);
      return { itemId: String(id), metric, kind, granularity, points };
    },
    'history',
  );
}

async function readScores(
  app: FastifyInstance,
  id: bigint,
  query: ScoresQueryInput,
  retention: { hourlyHours: number; dailyDays: number },
): Promise<ScoresBody> {
  const db = app.db;
  const item = await getItemById(db, id);
  if (item === null) {
    throw new NotFoundError(`Item ${id} not found`);
  }
  const now = Date.now();
  const since =
    query.granularity === 'hour'
      ? new Date(now - Math.min(query.days * 24, retention.hourlyHours) * HOUR_MS)
      : new Date(now - Math.min(query.days, retention.dailyDays) * DAY_MS);

  const rows = await loadItemScoreHistory(db, id, query.window, query.granularity, since);
  return {
    itemId: String(id),
    window: query.window,
    granularity: query.granularity,
    points: rows.map((row) => ({
      t: row.computedAt.toISOString(),
      runId: String(row.runId),
      finalScore: row.finalScore,
      zScore: row.zScore,
      percentile: row.percentile,
      rankSource: row.rankSource,
      delta: row.delta,
    })),
  };
}

function safeParams(source: Source, metric: Metric, window: Window): ScoringParams | null {
  try {
    return paramsFor(source, metric, window);
  } catch {
    // A source/metric combo without a §8.3 entry; the stored components still explain.
    return null;
  }
}

async function readScoreExplain(
  app: FastifyInstance,
  id: bigint,
  window: Window,
): Promise<ScoreExplainBody> {
  const db = app.db;
  const item = await getItemById(db, id);
  if (item === null) {
    throw new NotFoundError(`Item ${id} not found`);
  }
  const params = safeParams(item.source, item.primaryMetric, window);
  const current = await getCurrentScoreRun(db, item.source, window);
  if (current === null) {
    return {
      itemId: String(id),
      source: item.source,
      window,
      runId: null,
      computedAt: null,
      components: null,
      params,
      inputs: null,
      reason: 'not_eligible',
    };
  }

  const row = await loadItemScoreForRun(db, id, window, current.runId);
  if (row === null) {
    return {
      itemId: String(id),
      source: item.source,
      window,
      runId: String(current.runId),
      computedAt: current.computedAt.toISOString(),
      components: null,
      params,
      inputs: null,
      reason: 'not_eligible',
    };
  }

  return {
    itemId: String(id),
    source: item.source,
    window,
    runId: String(current.runId),
    computedAt: current.computedAt.toISOString(),
    components: {
      delta: row.delta,
      base: row.base,
      relGrowth: row.relGrowth,
      rawScore: row.rawScore,
      ageFactor: row.ageFactor,
      confidence: row.confidence,
      anomalyPenalty: row.anomalyPenalty,
      finalScore: row.finalScore,
    },
    params,
    inputs: {
      delta: row.delta,
      base: row.base,
      anomalyPenalty: row.anomalyPenalty,
      zScore: row.zScore,
      percentile: row.percentile,
      rankSource: row.rankSource,
      rankAll: row.rankAll,
      flags: row.flags,
    },
  };
}

async function readAliases(app: FastifyInstance, id: bigint): Promise<ItemAliasesBody> {
  const db = app.db;
  const item = await getItemById(db, id);
  if (item === null) {
    throw new NotFoundError(`Item ${id} not found`);
  }
  const links = await loadItemAliasLinks(db, id);
  return {
    itemId: String(id),
    aliases: links.map((link) => ({
      id: String(link.id),
      source: link.source,
      kind: link.kind,
      externalId: link.externalId,
      displayName: link.displayName,
      url: link.url,
      relation: link.relation,
      confidence: link.confidence,
      evidence: link.evidence,
      direction: link.direction,
    })),
  };
}

export function registerItemRoutes(app: FastifyInstance, options: ItemRoutesOptions = {}): void {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const retention = options.scoresRetention ?? DEFAULT_SCORES_RETENTION;

  // Static route: wins over `/v1/items/:id` (find-my-way priority).
  server.get(
    '/v1/items/lookup',
    { schema: { querystring: LookupQuery } },
    async (request, reply) => {
      const found = await findItemByNaturalKey(
        app.db,
        request.query.source,
        request.query.externalId,
      );
      if (found === null) {
        throw new NotFoundError(
          `No ${request.query.source} item with externalId "${request.query.externalId}"`,
        );
      }
      return reply.redirect(`/v1/items/${found.id}`, 302);
    },
  );

  server.get(
    '/v1/items/:id',
    {
      config: { cacheControl: CACHE_CONTROL.publicLong },
      schema: { params: IdParam, response: { 200: ItemDetailResponse } },
    },
    async (request) => {
      const id = parseItemId(request.params.id);
      return cached(
        app,
        redisKeys.item(id),
        ITEM_DETAIL_TTL_SECONDS,
        () => readItemDetail(app, id),
        'item',
      );
    },
  );

  server.get(
    '/v1/items/:id/history',
    {
      config: { cacheControl: CACHE_CONTROL.publicLong },
      schema: {
        params: IdParam,
        querystring: HistoryQuery,
        response: { 200: HistoryResponse },
      },
    },
    async (request) => {
      return readHistory(app, parseItemId(request.params.id), request.query);
    },
  );

  server.get(
    '/v1/items/:id/scores',
    {
      config: { cacheControl: CACHE_CONTROL.publicLong },
      schema: {
        params: IdParam,
        querystring: ScoresQuery,
        response: { 200: ScoresResponse },
      },
    },
    async (request) => {
      return readScores(app, parseItemId(request.params.id), request.query, retention);
    },
  );

  server.get(
    '/v1/items/:id/score-explain',
    {
      config: { cacheControl: CACHE_CONTROL.publicLong },
      schema: {
        params: IdParam,
        querystring: ScoreExplainQuery,
        response: { 200: ScoreExplainResponse },
      },
    },
    async (request) => {
      return readScoreExplain(app, parseItemId(request.params.id), request.query.window);
    },
  );

  server.get(
    '/v1/items/:id/aliases',
    {
      config: { cacheControl: CACHE_CONTROL.publicLong },
      schema: { params: IdParam, response: { 200: ItemAliasesResponse } },
    },
    async (request) => {
      return readAliases(app, parseItemId(request.params.id));
    },
  );
}
