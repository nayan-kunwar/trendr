import { Client } from 'pg';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';
import {
  dropOldPartitions,
  ensurePartitions,
  PartitionWindowBlockedError,
  partitionLeadDays,
} from '../../src/partitions.js';

/**
 * Task 1.2 acceptance: `0001_partitions.sql` on a fresh PG16 — partitions exist
 * for −2..+3 months, bounds are UTC midnights even in a `TimeZone='Asia/Kolkata'`
 * session, the database default answers `SHOW TimeZone` with UTC, inserts route
 * to the right partition and `dropOldPartitions` removes an old one.
 *
 * M-11 adds the twelve-month lead and the `snapshots_default` pre-flight guard.
 */

const PARTITION_NAME_RE = '^snapshots_\\d{4}_\\d{2}$';

function utcMonthName(offset: number): string {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `snapshots_${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function listNamedPartitions(db: Db): Promise<string[]> {
  const result = await db.execute<{ relname: string }>(sql`
    SELECT c.relname FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'snapshots' AND c.relname ~ ${PARTITION_NAME_RE}
    ORDER BY c.relname`);
  return result.rows.map((row) => row.relname);
}

describe('snapshot partitions (0001_partitions.sql)', () => {
  let connection: Connection;
  let db: Db;

  beforeAll(() => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
    connection = createDb(databaseUrl);
    db = connection.db;
  });

  afterAll(async () => {
    await connection.pool.end();
  });

  it('defaults every new session to TimeZone = UTC (0001 ALTER DATABASE)', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is missing');
    const session = new Client({ connectionString: databaseUrl });
    await session.connect();
    try {
      const result = await session.query<{ TimeZone: string }>('SHOW TimeZone');
      expect(result.rows[0]?.TimeZone).toBe('UTC');
    } finally {
      await session.end();
    }
  });

  it('created partitions for −2..+3 months', async () => {
    const parts = await listNamedPartitions(db);
    for (let offset = -2; offset <= 3; offset += 1) {
      expect(parts).toContain(utcMonthName(offset));
    }
  });

  it('is idempotent', async () => {
    const before = await listNamedPartitions(db);
    await ensurePartitions(db, 2, 3);
    const after = await listNamedPartitions(db);
    expect(after).toEqual(before);
  });

  it('renders UTC midnight bounds even inside a TimeZone=Asia/Kolkata session', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');

    // A dedicated single-connection pool: `SET` and every statement it must
    // affect have to share one session, which a pooled `db` cannot guarantee.
    const session = createDb(databaseUrl, { max: 1 });
    try {
      await session.db.execute(sql`SET TimeZone = 'Asia/Kolkata'`);

      // Force fresh partitions inside the non-UTC session: +4 and +5 months.
      await ensurePartitions(session.db, 0, 5);

      const result = await session.db.execute<{ relname: string; bound: string }>(sql`
        SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
        FROM pg_inherits i
        JOIN pg_class c ON c.oid = i.inhrelid
        JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'snapshots' AND c.relname ~ ${PARTITION_NAME_RE}`);
      expect(result.rows.length).toBeGreaterThanOrEqual(6);

      const nameRe = /^snapshots_(\d{4})_(\d{2})$/;
      for (const { relname, bound } of result.rows) {
        const nameMatch = nameRe.exec(relname);
        expect(nameMatch, `unexpected partition name: ${relname}`).not.toBeNull();
        const [, yearText, monthText] = nameMatch ?? [];
        if (yearText === undefined || monthText === undefined) throw new Error('unreachable');
        const year = Number(yearText);
        const monthIndex = Number(monthText) - 1;

        const match = /FROM \('([^']+)'\) TO \('([^']+)'\)/.exec(bound);
        expect(match, `unexpected bound expression: ${bound}`).not.toBeNull();
        const [, lo, hi] = match ?? [];
        if (lo === undefined || hi === undefined) throw new Error('unreachable');

        // pg_get_expr renders the bound constant in the session TimeZone (so it
        // shows +05:30 here); the instants behind the literals must still be the
        // UTC month midnights the partition name claims.
        expect(Date.parse(lo.replace(' ', 'T'))).toBe(Date.UTC(year, monthIndex, 1));
        expect(Date.parse(hi.replace(' ', 'T'))).toBe(Date.UTC(year, monthIndex + 1, 1));
      }

      const timezone = await session.db.execute<{ TimeZone: string }>(sql`SHOW TimeZone`);
      expect(timezone.rows[0]?.TimeZone).toBe('Asia/Kolkata');
    } finally {
      await session.pool.end();
    }
  });

  it('routes inserts to the month partition and the default catch-all', async () => {
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO items (source, kind, external_id, name, display_name, url, primary_metric)
      VALUES ('github'::source_t, 'repo'::item_kind_t, 'acme/routing-fixture',
              'routing-fixture', 'acme/routing-fixture',
              'https://github.com/acme/routing-fixture', 'stars'::metric_t)
      RETURNING id`);
    const itemId = inserted.rows[0]?.id;
    if (itemId === undefined) throw new Error('item insert returned no id');

    await db.execute(sql`
      INSERT INTO snapshots (item_id, metric, captured_at, value)
      VALUES (${itemId}::bigint, 'stars'::metric_t, now(), 1)`);
    await db.execute(sql`
      INSERT INTO snapshots (item_id, metric, captured_at, value)
      VALUES (${itemId}::bigint, 'stars'::metric_t, '2019-01-15T00:00:00Z', 7)`);

    const routed = await db.execute<{ part: string; captured_at: string }>(sql`
      SELECT tableoid::regclass::text AS part, captured_at
      FROM snapshots WHERE item_id = ${itemId}::bigint ORDER BY captured_at`);
    // Ascending captured_at: the 2019 row (default catch-all) first, then the month partition.
    expect(routed.rows.map((row) => row.part)).toEqual(['snapshots_default', utcMonthName(0)]);

    // Keep snapshots_default empty: a 2019 row would block creating a 2019 partition (spec §6.3).
    await db.execute(sql`
      DELETE FROM snapshots WHERE item_id = ${itemId}::bigint`);
    await db.execute(sql`DELETE FROM items WHERE id = ${itemId}::bigint`);
  });

  it('reports the partition lead in days (M-11)', async () => {
    await ensurePartitions(db, 0, 12);
    // Twelve months ahead means the newest partition ends ~13 months out.
    expect(await partitionLeadDays(db)).toBeGreaterThan(300);
  });

  it('refuses to create partitions that snapshots_default would block (M-11)', async () => {
    // A row 18 months out has no monthly partition yet, so it lands in the
    // default catch-all. Widening the window to cover it must fail before DDL.
    const inserted = await db.execute<{ id: string }>(sql`
      INSERT INTO items (source, kind, external_id, name, display_name, url, primary_metric)
      VALUES ('github'::source_t, 'repo'::item_kind_t, 'acme/m11-guard-fixture',
              'm11-guard', 'acme/m11-guard',
              'https://github.com/acme/m11-guard', 'stars'::metric_t)
      RETURNING id`);
    const itemId = inserted.rows[0]?.id;
    if (itemId === undefined) throw new Error('guard fixture item was not inserted');

    try {
      await db.execute(sql`
        INSERT INTO snapshots (item_id, metric, captured_at, value)
        VALUES (${itemId}::bigint, 'stars'::metric_t, now() + interval '18 months', 1)`);

      await expect(ensurePartitions(db, 0, 18)).rejects.toBeInstanceOf(PartitionWindowBlockedError);
      const missing = await db.execute<{ absent: boolean }>(sql`
        SELECT to_regclass('snapshots_' || to_char(now() + interval '18 months', 'YYYY_MM')) IS NULL AS absent`);
      // The guard runs before DDL, so the blocked window is untouched.
      expect(missing.rows[0]?.absent).toBe(true);
    } finally {
      await db.execute(sql`DELETE FROM snapshots WHERE item_id = ${itemId}::bigint`);
      await db.execute(sql`DELETE FROM items WHERE id = ${itemId}::bigint`);
    }
  });

  it('dropOldPartitions removes an old partition and reports the count', async () => {
    // Defensive: never let a previous test's default-partition row block the CREATE below.
    await db.execute(sql`DELETE FROM snapshots_default WHERE captured_at < '2020-01-01T00:00:00Z'`);

    await db.execute(sql`
      CREATE TABLE snapshots_2019_01 PARTITION OF snapshots
      FOR VALUES FROM ('2019-01-01 00:00:00+00') TO ('2019-02-01 00:00:00+00')`);

    const dropped = await dropOldPartitions(db, 3);
    expect(dropped).toBeGreaterThanOrEqual(1);

    const gone = await db.execute<{ absent: boolean }>(sql`
      SELECT to_regclass('snapshots_2019_01') IS NULL AS absent`);
    expect(gone.rows[0]?.absent).toBe(true);

    // Second call with nothing old left must be a no-op.
    await expect(dropOldPartitions(db, 3)).resolves.toBe(0);
  });
});
