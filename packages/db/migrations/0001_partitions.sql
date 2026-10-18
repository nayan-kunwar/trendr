-- 0001_partitions.sql — hand-written (spec §6.3, task 1.2); added with
-- `drizzle-kit generate --custom --name partitions` so the journal stays in sync.
-- `snapshots` is partitioned by month and is intentionally invisible to
-- drizzle-kit's schema diffing (see schema/snapshots.ts and drizzle.config.ts).

CREATE TABLE snapshots (
  item_id     bigint      NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  metric      metric_t    NOT NULL,
  captured_at timestamptz NOT NULL,             -- bucket start (hour or day)
  observed_at timestamptz NOT NULL DEFAULT now(),
  value       bigint      NOT NULL CHECK (value >= 0),
  run_id      bigint,
  PRIMARY KEY (item_id, metric, captured_at)    -- partition key included → valid unique key
) PARTITION BY RANGE (captured_at);--> statement-breakpoint

CREATE TABLE snapshots_default PARTITION OF snapshots DEFAULT;--> statement-breakpoint

-- Every session on this database defaults to UTC (date ↔ timestamptz casts, e.g. in rollup-daily, depend on it).
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$;--> statement-breakpoint

-- Creates monthly partitions [month_start, next_month) in UTC for N months back/ahead; idempotent.
-- Bounds are rendered as explicit '+00' literals, so they are UTC midnights whatever the session TimeZone is.
CREATE OR REPLACE FUNCTION ensure_snapshot_partitions(months_back int, months_ahead int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m    timestamp;   -- month start as UTC wall-clock time (timestamp WITHOUT time zone)
  lo   text;        -- e.g. '2026-10-01 00:00:00+00'
  hi   text;        -- e.g. '2026-11-01 00:00:00+00'
  part text;
BEGIN
  FOR i IN -months_back..months_ahead LOOP
    m    := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i);
    part := format('snapshots_%s', to_char(m, 'YYYY_MM'));
    lo   := to_char(m, 'YYYY-MM-DD HH24:MI:SS') || '+00';
    hi   := to_char(m + interval '1 month', 'YYYY-MM-DD HH24:MI:SS') || '+00';
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF snapshots FOR VALUES FROM (%L::timestamptz) TO (%L::timestamptz)',
        part, lo, hi);
      EXECUTE format('CREATE INDEX %I ON %I USING brin (captured_at)', part || '_brin', part);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

SELECT ensure_snapshot_partitions(2, 3);--> statement-breakpoint

-- Retention: drops whole partitions older than keep_months (O(1), no vacuum bloat).
CREATE OR REPLACE FUNCTION drop_old_snapshot_partitions(keep_months int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  r record; dropped int := 0;
  cutoff date := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => keep_months))::date;
BEGIN
  FOR r IN
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'snapshots' AND c.relname ~ '^snapshots_\d{4}_\d{2}$'
  LOOP
    IF to_date(substr(r.relname, 11), 'YYYY_MM') < cutoff THEN
      EXECUTE format('DROP TABLE %I', r.relname);
      dropped := dropped + 1;
    END IF;
  END LOOP;
  RETURN dropped;
END $$;
