import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

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
