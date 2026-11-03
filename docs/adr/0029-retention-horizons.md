# ADR-0029 — Retention horizons and bounded job history

- Status: Accepted (Phase 7)
- Date: 2026-11-03
- Spec: §6.5 (retention), §7.7 (dead letter)
- Finding: L-10

## Context

Two stores grew without a horizon:

1. `daily_metrics` had no prune at all. Every discovery/backfill inserts a row
   per `(item_id, metric, day)`, and the scoring path reads it on every run, so
   an unbounded table slowly turns leaderboard latency into a disk problem.
   Spec §6.5 gives the horizon: 400 days.
2. `removeOnFail` kept failed BullMQ jobs for seven days with no count bound.
   A queue stuck in a retry storm (one failure per item per attempt) fills
   Redis long before the age limit matters. The dead-letter queue already holds
   the actionable copies, so the failed set only needs recent triage material.

The review's third clause, `topics.item_count` recompute cost, is bounded by
the only writer (`mergeItemStub` touches the topics a rename stub held) and the
`listTopics` index; no code change is needed, so it stays noted rather than
re-engineered.

## Decision

1. **`pruneDailyMetrics(db, before, batchSize)`** deletes `daily_metrics`
   rows older than the cutoff in `RETENTION_BATCH_SIZE` (1 000) batches, using
   the composite primary key to target rows. The maintenance `retention` job
   calls it with `DAILY_METRICS_RETENTION_DAYS = 400` relative to the job's
   clock and reports `deletedDailyMetrics`.
2. **`removeOnFail: { age: 7 days, count: 1000 }`** in `DEFAULT_JOB_OPTS`.
   BullMQ keeps the newest 1 000 failed jobs and drops anything older than a
   week; completed jobs keep the existing 24 h / 2 000 bound.

## Consequences

- `daily_metrics` plateaus at roughly 400 days of tracked items; the 400-day
  window still covers the 30-day daily scores horizon and the 365-day daily
  score retention.
- A retry storm cannot grow Redis without bound; recent failures for triage
  are still there, and the DLQ holds the final ones.
- The prune runs inside the existing retention job, in bounded batches, so it
  never blocks the worker on one large delete.

## Verification

- `apps/worker/test/int/maintenance.int.test.ts`: a `2025-01-01` daily row is
  deleted by the retention job while the 2026 rollup rows survive, and the
  result reports `deletedDailyMetrics ≥ 1`.
- `packages/core` job-option unit coverage (if any) picks up the new count;
  the default is exercised by every queue integration test.
