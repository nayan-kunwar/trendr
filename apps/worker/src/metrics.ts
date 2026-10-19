import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

import type { FetchJsonMetricsSink, SourceApiErrorKind } from '@trendr/core';

/**
 * Worker metrics (spec §14.1). One registry per process: the metrics server
 * serves it and every job runner writes to it, so `/metrics` reflects live
 * job state.
 */

/** A registry with the standard `trendr_*` process metrics registered. */
export function createRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ prefix: 'trendr_', register: registry });
  return registry;
}

/** Shared by `main.ts`, the metrics server and the job runners. */
export const registry = createRegistry();

/** `trendr_scoring_duration_seconds{source,window}` — one observation per pass. */
export const scoringDuration = new Histogram({
  name: 'trendr_scoring_duration_seconds',
  help: 'Wall-clock duration of one (source, window) scoring pass.',
  labelNames: ['source', 'window'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

/**
 * `trendr_scoring_items{source,window,eligibility}` — evaluated items split by
 * eligibility, so the rate of scored items is visible per source and window
 * (spec §8.4/§14.1). Ineligible items get no `scores` row.
 */
export const scoringItems = new Gauge({
  name: 'trendr_scoring_items',
  help: 'Items evaluated by the latest scoring run, by eligibility.',
  labelNames: ['source', 'window', 'eligibility'],
  registers: [registry],
});

/** `trendr_scoring_anomalies_total{source,type}` — bursts, spikes, resets (spec §8.5, §8.8). */
export const scoringAnomalies = new Counter({
  name: 'trendr_scoring_anomalies_total',
  help: 'Anomalies detected while scoring: burst, daily spike or counter reset.',
  labelNames: ['source', 'type'],
  registers: [registry],
});

/** `trendr_dlq_jobs_total{queue}` — jobs parked in `dead-letter` (spec §7.7, §14.1). */
export const dlqJobsTotal = new Counter({
  name: 'trendr_dlq_jobs_total',
  help: 'Jobs parked in the dead-letter queue after their final attempt failed.',
  labelNames: ['queue'],
  registers: [registry],
});

/**
 * `trendr_source_api_requests_total{source,endpoint,status}` — every upstream
 * HTTP request a source adapter makes (spec §14.1).
 */
export const sourceApiRequests = new Counter({
  name: 'trendr_source_api_requests_total',
  help: 'Upstream API requests made by source adapters.',
  labelNames: ['source', 'endpoint', 'status'],
  registers: [registry],
});

/** `trendr_source_api_errors_total{source,endpoint,kind}` — failures by error kind. */
export const sourceApiErrors = new Counter({
  name: 'trendr_source_api_errors_total',
  help: 'Upstream API errors by kind (network, schema, rate limited, …).',
  labelNames: ['source', 'endpoint', 'kind'],
  registers: [registry],
});

/** `trendr_source_api_duration_seconds{source,endpoint}` — request wall-clock time. */
export const sourceApiDuration = new Histogram({
  name: 'trendr_source_api_duration_seconds',
  help: 'Wall-clock duration of upstream API requests.',
  labelNames: ['source', 'endpoint'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [registry],
});

/** `trendr_rate_limit_remaining{source,resource}` — last observed budget (spec §7.4). */
export const rateLimitRemaining = new Gauge({
  name: 'trendr_rate_limit_remaining',
  help: 'Last observed upstream rate-limit remaining value.',
  labelNames: ['source', 'resource'],
  registers: [registry],
});

/** GAP-8: `trendr_source_token_expires_timestamp_seconds{source,token_index}`. */
export const tokenExpiryTimestamp = new Gauge({
  name: 'trendr_source_token_expires_timestamp_seconds',
  help: 'Unix timestamp when a source API token expires (fine-grained PAT header).',
  labelNames: ['source', 'token_index'],
  registers: [registry],
});

/**
 * The `FetchJsonMetricsSink` adapters receive through `AdapterContext`
 * (spec §12) plus the §7.4 and GAP-8 hooks.
 */
export const sourceApiMetrics = {
  request(source: string, endpoint: string, status: string): void {
    sourceApiRequests.inc({ source, endpoint, status });
  },
  error(source: string, endpoint: string, kind: SourceApiErrorKind): void {
    sourceApiErrors.inc({ source, endpoint, kind });
  },
  duration(source: string, endpoint: string, seconds: number): void {
    sourceApiDuration.observe({ source, endpoint }, seconds);
  },
  rateLimit(source: string, resource: string, remaining: number): void {
    rateLimitRemaining.set({ source, resource }, remaining);
  },
  tokenExpiry(source: string, tokenIndex: number, expiresAt: Date): void {
    tokenExpiryTimestamp.set(
      { source, token_index: String(tokenIndex) },
      expiresAt.getTime() / 1000,
    );
  },
} satisfies FetchJsonMetricsSink & {
  rateLimit(source: string, resource: string, remaining: number): void;
  tokenExpiry(source: string, tokenIndex: number, expiresAt: Date): void;
};
