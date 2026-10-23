# Trendr operations runbook

This runbook covers the Phase 9 operational surface: metrics, dashboards, alerts,
retention/rollup jobs, partition checks, credential rotation, and common
incidents. All times are **UTC** unless stated otherwise. Commands assume the
repository root and the Compose stack from §17.

## 1. Observability

### Endpoints

| Surface | URL / access |
| --- | --- |
| API metrics | `http://localhost:4000/metrics` with `Authorization: Bearer $METRICS_TOKEN` |
| Worker health | `/healthz` liveness; `/readyz` readiness (503 when Redis is down): `docker compose exec worker node -e "fetch('http://localhost:9464/readyz').then(r=>process.exit(r.ok?0:1))"` |
| Worker metrics | internal only; Prometheus scrapes `worker:9464` with `METRICS_TOKEN` |
| Prometheus | `http://localhost:9090` (profile `obs`) |
| Grafana | `http://localhost:3001`; dashboard **Trendr Overview** |
| Jaeger | `http://localhost:16686` (optional tracing, §14.6) |

```bash
# Start the core stack, then the observability profile.
docker compose up -d --wait
docker compose --profile obs up -d prometheus grafana
pnpm obs:smoke   # rules + targets + provisioned dashboard

curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:4000/metrics |
  grep -E '^# HELP trendr_'
```

`METRICS_TOKEN` is rendered by Compose into a read-only file
(`/etc/prometheus/metrics.token`, via `configs.content`) because Prometheus
deliberately does not expand environment variables inside config files
(prometheus/prometheus#2357). Change it in `.env` (or the platform secret
store) and restart Prometheus. Never publish worker port 9464.

### Alert rules

`infra/prometheus/alerts.yml` contains the six §14.2 rules:
`IngestionStale`, `UpstreamRateLimited`, `DeadLetterGrowing`,
`ApiHighErrorRate`, `ApiSlowLeaderboard`, `SnapshotsDefaultNotEmpty`.

Validate before shipping:

```bash
docker run --rm \
  -v "$PWD/infra/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v2.55.1 \
  check rules /etc/prometheus/alerts.yml
```

Prometheus loads rules by `rule_files`; after editing, reload with
`curl -X POST http://localhost:9090/-/reload` (or restart the container).

### Useful PromQL

```promql
# API 5xx ratio and p95
sum(rate(trendr_http_requests_total{status=~"5.."}[5m]))
  / sum(rate(trendr_http_requests_total[5m]))
histogram_quantile(0.95, sum by (le) (rate(trendr_http_request_duration_seconds_bucket[5m])))

# Pipeline
sum by (queue, state) (trendr_queue_depth)
max by (source, tier) (trendr_data_freshness_seconds)
sum by (source, kind) (increase(trendr_source_api_errors_total[15m]))
histogram_quantile(0.95, sum by (le, source) (rate(trendr_ingestion_duration_seconds_bucket[15m])))

# Cache, tokens, and the partition guard
sum by (cache) (rate(trendr_cache_requests_total{result="hit"}[15m]))
  / clamp_min(sum by (cache) (rate(trendr_cache_requests_total[15m])), 1e-9)
time() < trendr_source_token_expires_timestamp_seconds
max(trendr_snapshots_default_rows)
```

Worker metrics are scraped from a separate registry; use the Prometheus
`job="worker"` selector when a metric name exists on both processes (for
example `trendr_db_pool_connections`).

## 2. Manual maintenance jobs

All jobs are idempotent. The CLI enqueues the real BullMQ job onto the
`maintenance` queue and waits for completion, so the **running worker** executes
it and updates worker gauges (especially `trendr_snapshots_default_rows`).

```bash
# Build once (or rebuild after a deploy).
pnpm --filter @trendr/worker build

# Run inside Compose (the worker image contains dist/maintenance-cli.js).
docker compose exec worker node dist/maintenance-cli.js create-partitions
docker compose exec worker node dist/maintenance-cli.js rollup-daily
docker compose exec worker node dist/maintenance-cli.js retention
docker compose exec worker node dist/maintenance-cli.js cleanup-tokens
docker compose exec worker node dist/maintenance-cli.js retier-items
```

Locally, with `.env` loaded and a live worker:

```bash
pnpm --filter @trendr/worker maintenance -- retention
```

If the worker is not running, calling the processor SQL directly from `psql` is
safe for the data but does **not** update the worker metric:

```sql
-- create partitions (0..+3 months)
SELECT ensure_snapshot_partitions(0, 3);
SELECT count(*) AS snapshots_default_rows FROM snapshots_default;

-- rollup a specific UTC day
INSERT INTO daily_metrics (item_id, metric, day, value)
SELECT DISTINCT ON (item_id, metric) item_id, metric, DATE '2026-10-19', value
FROM snapshots
WHERE captured_at >= DATE '2026-10-19' AND captured_at < DATE '2026-10-20'
  AND metric IN ('stars','forks','likes','upvotes','downloads_total','comments','watchers')
ORDER BY item_id, metric, captured_at DESC
ON CONFLICT (item_id, metric, day) DO UPDATE SET value = EXCLUDED.value;

-- drop whole snapshot partitions older than 3 months
SELECT drop_old_snapshot_partitions(3);
```

### Schedules

| Job | UTC schedule | What it does |
| --- | --- | --- |
| `rollup-daily` | `20 0 * * *` | previous-day end-of-day values → `daily_metrics` |
| `create-partitions` | `0 1 * * *` | `ensure_snapshot_partitions(0, 3)` + default-row gauge |
| `retention` | `30 3 * * *` | snapshot partitions, scores, alert events, ingestion runs |
| `cleanup-tokens` | `0 4 * * 0` | auth tokens expired/revoked > 7 days |
| `retier-items` | `0 5 * * *` | hot/warm/cold re-tiering |

Schedules are registered by the worker role containing `scheduler`; inspect them
with `docker compose logs worker | grep scheduler` or Redis/BullMQ.

### Retention policy (§6.5)

| Data | Policy | Job |
| --- | --- | --- |
| `snapshots` | drop partitions older than `SNAPSHOT_RETENTION_MONTHS` (3) | `retention` |
| `scores` | keep every run for `SCORES_HOURLY_RETENTION_HOURS` (48); then one (last) run per source/window/UTC day for `SCORES_DAILY_RETENTION_DAYS` (365); current run always kept | `retention` |
| `ingestion_runs` | 30 days, except runs referenced by kept scores/current/alert events | `retention` |
| `alert_events` | 180 days | `retention` |
| `auth_tokens` | delete 7 days after expiry/revocation | `cleanup-tokens` |
| `daily_metrics` | kept forever by default | — |

`daily_metrics` growth is about 55M rows/year for 50k items × 3 metrics. On a
small database, trim it manually in bounded batches (the retention job
deliberately does not do this):

```sql
-- Repeat until 0 rows are deleted.
WITH doomed AS (
  SELECT ctid FROM daily_metrics
  WHERE day < current_date - 400
  LIMIT 10000
)
DELETE FROM daily_metrics d USING doomed WHERE d.ctid = doomed.ctid;
```

Verify score retention (the same invariants as the integration test):

```sql
-- Every run inside 48h survives; older runs have one per day/window/source.
SELECT source, "window", (started_at AT TIME ZONE 'UTC')::date AS day,
       count(*) AS runs_kept
FROM ingestion_runs r
WHERE job_type = 'score'
  AND EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id)
  AND started_at < now() - interval '48 hours'
GROUP BY source, "window", day
HAVING count(*) <> 1;

-- No score row may reference a missing run.
SELECT count(*) FROM scores s
LEFT JOIN ingestion_runs r ON r.id = s.run_id
WHERE r.id IS NULL;
```

### Partition guard (ISS-7)

`snapshots_default` must stay empty. A non-zero
`trendr_snapshots_default_rows` means a date range was written before its
monthly partition existed, and `CREATE TABLE ... PARTITION OF` for that range
will fail. Run `create-partitions`; if the gauge stays non-zero, inspect:

```sql
SELECT min(captured_at), max(captured_at), count(*)
FROM snapshots_default;
```

Do not drop `snapshots_default` manually while it has rows. Move rows to the
correct partition (create it first) or archive them, then re-check the gauge.

## 3. Credential rotation

### GitHub fine-grained PAT

1. Create a replacement PAT: public repositories read-only, no write scopes,
   90-day expiry; set a calendar reminder.
2. Update `GITHUB_TOKENS` in the secret store/`.env` (comma-separated; index
   order defines `github:core:{tokenIdx}` buckets).
3. Restart the worker (`docker compose up -d worker` or platform redeploy).
4. Confirm the new expiry metric and rate-limit budget:

```promql
trendr_source_token_expires_timestamp_seconds{source="github"}
trendr_rate_limit_remaining{source="github", resource="core"}
```

Old tokens can be revoked after the worker has scraped successfully.

### Hugging Face token

Read-only; update `HF_TOKEN` and restart only the worker. The API never receives
source credentials. Check `trendr_source_api_errors_total{source="huggingface"}`.

### Metrics token

Update `METRICS_TOKEN` in `.env`, restart the API/worker and Prometheus
(`docker compose up -d api worker prometheus`). Verify both targets are `up`
in Prometheus and `pnpm obs:smoke` passes.

## 4. Incident checklists

### API down / high 5xx

1. `docker compose ps api`; `docker compose logs --tail=200 api`.
2. Check `/readyz`: DB, Redis, migrations. A Redis failure is degraded (200);
   a DB or migration failure is unready (503).
3. Check `trendr_http_requests_total{status=~"5.."}` by route and
   `trendr_cache_requests_total`; a Redis breaker opens after 5 errors.
4. Roll back the last deploy or restart the API; confirm 5xx ratio drops.

### Worker down / queue backlog

1. `docker compose exec worker ... /readyz`; logs for `worker error`.
2. `trendr_queue_depth{state="waiting"}` and
   `trendr_queue_depth{queue="dead-letter",state="waiting"}`.
3. Check upstream errors (`rate_limited`, `network`, `server`) and
   `trendr_rate_limit_wait_seconds`; if rate limited, let BullMQ backoff retry.
4. If jobs are stuck `active`, restart the worker; BullMQ stalled-job recovery
   re-delivers them.
5. Inspect `/v1/admin/dlq`; replay after fixing the root cause.

### Stale data (`IngestionStale`)

1. Find the source/tier from `trendr_data_freshness_seconds`.
2. Check the source's schedules and `ingestion_runs` status/error.
3. Check the source token expiry and `trendr_source_api_errors_total`.
4. Trigger a manual ingest via `POST /v1/admin/ingest` (admin auth) or wait for
   the next scheduled run.

### Dead-letter growth

`DeadLetterGrowing` fires above 20 waiting jobs. Open `/v1/admin/dlq`, read
`failedReason`, fix the adapter/schema/config issue, then retry jobs. Dead
letters never disappear on their own; the queue is a triage surface.

### `SnapshotsDefaultNotEmpty`

Treat as critical: new snapshot inserts for that date range may be misrouted.
Run `create-partitions`, inspect `snapshots_default`, and follow §2 above.

## 5. Backups and restore (preview)

Phase 10 adds the complete backup story. Until then, before risky maintenance:

```bash
docker compose exec -T postgres pg_dump -U trendr -d trendr -Fc > trendr-$(date +%F).dump
# restore (empty database)
docker compose exec -T postgres pg_restore -U trendr -d trendr --clean --if-exists < trendr-YYYY-MM-DD.dump
```

Redis is a cache/queue, not a source of truth: back up Postgres only. Losing
Redis means boards rebuild on the next scoring run and queued jobs are lost.
