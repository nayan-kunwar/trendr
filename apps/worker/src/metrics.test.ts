import { afterAll, describe, expect, it } from 'vitest';

import { registry, setDbPoolStats, snapshotsDefaultRows } from './metrics.js';

/** Spec §14.1 — the worker registry exposes every metric owned by the worker. */
const WORKER_METRICS = [
  'trendr_ingestion_duration_seconds',
  'trendr_ingestion_items_total',
  'trendr_source_api_requests_total',
  'trendr_source_api_errors_total',
  'trendr_source_api_duration_seconds',
  'trendr_rate_limit_remaining',
  'trendr_rate_limit_wait_seconds',
  'trendr_queue_depth',
  'trendr_job_duration_seconds',
  'trendr_dlq_jobs_total',
  'trendr_scoring_duration_seconds',
  'trendr_scoring_items',
  'trendr_scoring_anomalies_total',
  'trendr_data_freshness_seconds',
  'trendr_alerts_fired_total',
  'trendr_emails_sent_total',
  'trendr_db_pool_connections',
  'trendr_snapshots_default_rows',
  'trendr_source_token_expires_timestamp_seconds',
];

afterAll(() => {
  setDbPoolStats(undefined);
});

describe('worker metrics registry (spec §14.1)', () => {
  it('registers every worker metric name', async () => {
    setDbPoolStats({ totalCount: 1, idleCount: 0, waitingCount: 0 });
    snapshotsDefaultRows.set(0);
    const text = await registry.metrics();
    for (const name of WORKER_METRICS) {
      expect(text, `${name} is registered`).toContain(`# HELP ${name}`);
    }
  });
});
