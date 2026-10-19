import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';

import { NotFoundError, ValidationError, WINDOW_DAYS } from '@trendr/core';
import { getItemById, loadCurrentScoresForItems } from '@trendr/db';

import { CACHE_CONTROL } from '../plugins/etag.js';
import { MAX_ITEM_ID } from '../schemas/common.js';
import {
  CompareQuery,
  CompareResponse,
  type CompareBody,
  type CompareItem,
  type CompareQueryInput,
} from '../schemas/compare.js';
import {
  loadMetricSeries,
  truncateToGranularity,
  type SeriesPoint,
} from '../services/item.service.js';

/**
 * Spec §10.1/§10.5 — `GET /v1/compare`: 2–5 items side by side. Growth fields
 * come from the current run's score row for the window; the per-item series
 * is the same metric history `/v1/items/:id/history` serves, for the requested
 * metric (or each item's primary metric). Cache-Control is the §9.4
 * `publicShort` set; the ETag is the plugin's body hash.
 */

const DAY_MS = 86_400_000;
export const MIN_COMPARE_IDS = 2;
export const MAX_COMPARE_IDS = 5;

/** `ids=1,2,3` → item ids; 400 for < 2, > 5, malformed or duplicate ids. */
export function parseCompareIds(raw: string): bigint[] {
  const parts = raw.split(',').map((part) => part.trim());
  if (parts.length < MIN_COMPARE_IDS || parts.length > MAX_COMPARE_IDS) {
    throw new ValidationError(`ids must contain ${MIN_COMPARE_IDS} to ${MAX_COMPARE_IDS} item ids`);
  }
  const seen = new Set<string>();
  const ids: bigint[] = [];
  for (const part of parts) {
    if (!/^\d{1,19}$/.test(part)) {
      throw new ValidationError(`"${part}" is not a valid item id`);
    }
    if (seen.has(part)) {
      throw new ValidationError('ids must be distinct');
    }
    const id = BigInt(part);
    if (id > MAX_ITEM_ID) {
      throw new NotFoundError(`Item ${part} not found`);
    }
    seen.add(part);
    ids.push(id);
  }
  return ids;
}

/** Default granularity: hour for the 24h/7d windows, day for 30d (SPEC_REVIEW). */
export function resolveCompareGranularity(query: CompareQueryInput): 'hour' | 'day' {
  return query.granularity ?? (query.window === '30d' ? 'day' : 'hour');
}

async function readCompare(app: FastifyInstance, query: CompareQueryInput): Promise<CompareBody> {
  const db = app.db;
  const ids = parseCompareIds(query.ids);
  const granularity = resolveCompareGranularity(query);
  const now = new Date();
  const fromT = truncateToGranularity(
    new Date(now.getTime() - WINDOW_DAYS[query.window] * DAY_MS),
    granularity,
  );
  const toT = truncateToGranularity(now, granularity);

  const found = await Promise.all(ids.map((id) => getItemById(db, id)));
  const missing = ids.filter((_, index) => found[index] == null);
  if (missing.length > 0) {
    throw new NotFoundError(`Unknown item ids: ${missing.map((id) => String(id)).join(', ')}`);
  }

  const scores = await loadCurrentScoresForItems(db, ids, query.window);
  const items: CompareItem[] = [];
  const series: Record<string, SeriesPoint[]> = {};

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const item = found[index];
    if (id === undefined || item === undefined || item === null) {
      continue; // unreachable after the missing check; narrows the types.
    }
    const metric = query.metric ?? item.primaryMetric;
    series[String(id)] = await loadMetricSeries(db, id, metric, granularity, fromT, toT);
    const score = scores.get(id);
    items.push({
      id: String(id),
      source: item.source,
      kind: item.kind,
      name: item.name,
      displayName: item.displayName,
      url: item.url,
      delta: score?.delta ?? null,
      relGrowth: score?.relGrowth ?? null,
      percentile: score?.percentile ?? null,
      rankSource: score?.rankSource ?? null,
    });
  }

  return { window: query.window, granularity, metric: query.metric ?? null, items, series };
}

export function registerCompareRoutes(app: FastifyInstance): void {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get(
    '/v1/compare',
    {
      config: { cacheControl: CACHE_CONTROL.publicShort },
      schema: { querystring: CompareQuery, response: { 200: CompareResponse } },
    },
    async (request) => readCompare(app, request.query),
  );
}
