-- 0006_partition_lead.sql — hand-written via `drizzle-kit generate --custom`
-- (M-11, spec §6.3).
--
-- Two problems with a three-month lead: an outage longer than the lead (or a
-- missed create-partitions job) makes the next insert land in
-- `snapshots_default`, and once a row is there the overlapping monthly
-- partition can no longer be created until the row is moved. Widen the lead to
-- twelve months and expose the remaining lead plus a pre-flight guard.

-- Days from today (UTC) to the upper bound of the newest monthly partition.
-- 0 when no monthly partition exists. `maintenance:create-partitions` exports
-- it as `trendr_partition_lead_days`.
CREATE OR REPLACE FUNCTION snapshot_partition_lead_days()
RETURNS int LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    max(
      (to_date(substr(c.relname, 11), 'YYYY_MM') + interval '1 month')::date
        - (now() AT TIME ZONE 'UTC')::date
    )::int,
    0)
  FROM pg_inherits i
  JOIN pg_class c ON c.oid = i.inhrelid
  JOIN pg_class p ON p.oid = i.inhparent
  WHERE p.relname = 'snapshots' AND c.relname ~ '^snapshots_\d{4}_\d{2}$';
$$;--> statement-breakpoint

-- Rows sitting in `snapshots_default` inside the window a create-partitions
-- call would cover. Creating one of those partitions fails with a partition
-- constraint violation while the rows remain, so the maintenance job checks
-- this first and refuses with an actionable error.
CREATE OR REPLACE FUNCTION snapshot_partition_window_rows(months_back int, months_ahead int)
RETURNS bigint LANGUAGE sql STABLE AS $$
  SELECT count(*) FROM snapshots_default
  WHERE captured_at >= (
          to_char(
            date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => months_back),
            'YYYY-MM-DD HH24:MI:SS') || '+00'
        )::timestamptz
    AND captured_at < (
          to_char(
            date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => months_ahead + 1),
            'YYYY-MM-DD HH24:MI:SS') || '+00'
        )::timestamptz;
$$;--> statement-breakpoint

-- Apply the wider lead immediately instead of waiting for the next daily job.
SELECT ensure_snapshot_partitions(0, 12);
