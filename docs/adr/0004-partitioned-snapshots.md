# 0004 — Monthly-partitioned `snapshots`

- Status: Accepted
- Date: 2026-10-18
- Phase: 0 (design), 1.2 (implementation)
- Source: TRENDR_SPEC.md §6.3, §6.5

## Context

`snapshots` is the highest-volume table (hourly series for tens of thousands of items) and has a
hard retention rule (`SNAPSHOT_RETENTION_MONTHS`). Row-by-row deletes of expired data would bloat
the table and require heavy vacuuming; time-range scans need pruning to stay fast.

## Decision

`snapshots` is `PARTITION BY RANGE (captured_at)` with **UTC monthly partitions**
(`snapshots_YYYY_MM` plus a default partition), created idempotently by
`ensure_snapshot_partitions()` and removed by `drop_old_snapshot_partitions(keep_months)` in the
hand-written `0001_partitions.sql`:

- `ALTER DATABASE … SET timezone TO UTC` makes every session UTC, so date ↔ `timestamptz` casts
  (e.g. in rollup jobs) are deterministic.
- Partition bounds are rendered as explicit `+00` literals — correct regardless of session timezone.
- Each partition carries a BRIN index on `captured_at` (perfect for append-only time ranges).
- The partition key is part of the primary key (`item_id, metric, captured_at`).
- `scores` is **not** partitioned: daily thinning keeps one run per (source, window, day), so a
  brute `DELETE` is bounded; revisit only if it exceeds 5 minutes (§6.5).

## Consequences

- Retention is `DROP TABLE` per month: O(1), no vacuum, no long transactions.
- Partition management is SQL, not Drizzle (ADR-0002), and needs the dedicated integration tests
  in Phase 1.2 (bounds at UTC midnights, routing, drops).
- A partition may lag behind `now()`; inserts always land somewhere (default partition), and the
  Phase 9.4 job monitors `trendr_snapshots_default_rows`.
