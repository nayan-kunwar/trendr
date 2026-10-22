# ADR-0019 — Observability boundaries and maintenance execution

- Status: Accepted (Phase 9)
- Date: 2026-10-22
- Spec: §14, §7.10, §17.4

## Context

The API and worker are separate processes with different metric owners. The spec
requires every §14.1 metric, a Prometheus/Grafana `obs` profile, two pollers
(queue depth every 15 s, freshness every 60 s), and maintenance jobs that also
update worker gauges. Prometheus must authenticate to both `/metrics`
endpoints, and operators need a safe way to run jobs manually.

## Decision

1. **Separate registries.** The API builds a per-app `Registry` inside
   `registerMetrics`; the worker has one module-level registry shared by all
   processors and its metrics server. Both use `collectDefaultMetrics` with the
   `trendr_` prefix. Prometheus scrapes them as distinct jobs (`api`, `worker`),
   so the same metric name on both processes is not merged accidentally.
2. **Pollers live in the worker.** `trendr_queue_depth` comes from
   `Queue.getJobCounts` on every registered queue; `trendr_data_freshness_seconds`
   comes from one grouped SQL query over `items.last_snapshot_at`, excluding
   deleted/upstream-archived rows. Both poll immediately and then on unref'd
   timers, so the event loop can exit cleanly in tests and one-shot processes.
3. **Scrape-time pool counters.** `trendr_db_pool_connections` is a gauge with a
   `collect()` callback over `pg.Pool` counters, rather than a timer that copies
   values. Unlabelled/absent pools emit no series instead of a misleading zero.
4. **The token is rendered into a file, not into the config.** Prometheus's
   governance explicitly rejected environment-variable expansion inside config
   files (prometheus/prometheus#2357), so `--config.expand-env` does not exist
   there — the first `obs` smoke run failed on that flag. Compose instead
   renders `${METRICS_TOKEN}` through `configs.content` into a read-only
   `/etc/prometheus/metrics.token`, and both scrape jobs use
   `authorization.credentials_file`. The token is never committed in the
   Prometheus config. Images are pinned (`prom/prometheus:v2.55.1`,
   `grafana/grafana:11.4.0`, `jaeger 1.62.0`) so the dashboard/rule checks are
   reproducible.
5. **Maintenance CLI enqueues.** `maintenance-cli.ts` adds the real job to the
   `maintenance` queue and waits for the result. This guarantees the running
   worker executes it and updates `trendr_snapshots_default_rows`; direct SQL is
   documented only as an emergency fallback. The @trendr/db retention helpers
   batch deletes and preserve FK-referenced runs.
6. **OpenTelemetry remains opt-in and deferred.** The spec marks 9.5 optional;
   no SDK is loaded, so production by default has no tracing overhead. Jaeger
   stays in the `obs` profile for when OTEL instrumentation is added (R-41).
7. **`/metrics` sits outside the JWT hook.** The API's global bearer-verifying
   `onRequest` hook skips that one path, because Prometheus sends
   `Authorization: Bearer <METRICS_TOKEN>` and `jwtVerify()` would otherwise
   answer 401 before the route-level guard ran (reproduced against Compose,
   where `jwtSecret` is always set — unit tests without it never saw the
   collision). Every other bearer token is still verified, and `/metrics`
   still rejects anything that is not the metrics token.

## Consequences

- Dashboards must select the correct `job` when a metric exists in both
  registries; the runbook documents this.
- The worker must run with the `scoring` role (or another role that hosts the
  maintenance worker) for the CLI to complete.
- Prometheus reloads require a restart or `/-/reload` after a token change.
- Freshness is a lower bound of true ingestion freshness when archived items
  are intentionally excluded; this matches the operational meaning of the
  alert.
