# ADR-0026 — Partition lead time and default-partition guard

- Status: Accepted (Phase 4)
- Date: 2026-11-03
- Spec: §6.3 (deviation, recorded as R-55)
- Finding: M-11

## Context

Spec §6.3 bootstraps `snapshots` with `ensure_snapshot_partitions(2, 3)` and the
daily `maintenance:create-partitions` job kept that three-month horizon. Two
failure modes follow:

1. **Lead exhaustion.** If the job stops running (deploy error, paused worker,
   lost scheduler) for more than three months, the next insert has no monthly
   partition and lands in `snapshots_default`.
2. **Blocked recovery.** Once a row is in `snapshots_default` inside a month's
   range, `CREATE TABLE ... PARTITION OF` for that month fails with a partition
   constraint violation. The job aborts mid-loop, having created some partitions
   and not others, and repeats the same failure on every retry.

`snapshots_default` is meant to stay empty; the metric and
`SnapshotsDefaultNotEmpty` alert already existed, but nothing widened the lead
or turned the raw constraint error into an actionable pre-flight failure.

## Decision

1. **Twelve months ahead.** `maintenance:create-partitions` calls
   `ensurePartitions(db, 0, 12)`. Migration `0006_partition_lead.sql` calls
   `ensure_snapshot_partitions(0, 12)` so an existing deployment widens the lead
   at migrate time instead of waiting for the next daily job. `0001`'s bootstrap
   call is left untouched (applied migrations are never edited).
2. **Pre-flight guard.** `ensurePartitions` calls
   `snapshot_partition_window_rows(months_back, months_ahead)` first. If any
   `snapshots_default` row falls inside the window, it throws
   `PartitionWindowBlockedError` before any DDL, with the row count and the
   window in the message. The job therefore fails deterministically and opaquely
   never again — the operator gets the remediation ("move the rows, re-run").
3. **Lead metric and alert.** `snapshot_partition_lead_days()` returns the days
   from today (UTC) to the newest monthly partition's upper bound.
   `maintenance:create-partitions` exports it as
   `trendr_partition_lead_days`; `PartitionLeadShort` fires below 60 days with a
   1 h `for:` clause — far enough ahead to fix the job before inserts fall into
   the default.

## Consequences

- A deployment runs with roughly fifteen monthly partitions instead of five.
  Empty partitions cost catalog entries, not disk; the BRIN index on
  `captured_at` is created per partition as before.
- The guard evaluates the same UTC month arithmetic as
  `ensure_snapshot_partitions`, so the check and the DDL cannot disagree about a
  boundary. It is a read-only query; the DDL still runs in one call.
- A blocked window now produces one failed maintenance job with a precise error
  instead of a partially applied loop.
- The lead metric only updates when `create-partitions` runs, which is exactly
  the signal an operator needs: a stale or missing sample is itself the alarm
  (the alert uses `for: 1h`, and the gauge remains at its last value).

## Verification

- `packages/db/test/int/partitions.int.test.ts`: the lead exceeds 300 days after
  `ensurePartitions(0, 12)`; a row in `snapshots_default` 18 months out makes a
  wider call reject with `PartitionWindowBlockedError` and leaves the window
  untouched.
- `apps/worker/test/int/maintenance.int.test.ts`: the job reports `leadDays`
  above 300 and sets both gauges.
- `infra/prometheus/alerts.yml` gains `PartitionLeadShort`; CI validates the
  file with `promtool check rules`.
