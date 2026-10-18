import { createHmac } from 'node:crypto';

import { and, count, eq, inArray, max, min, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';
import { type SeedReport, seed } from '../../src/seed.js';
import { itemTopics, items, topics } from '../../src/schema/items.js';
import { dailyMetrics } from '../../src/schema/metrics.js';
import { snapshots } from '../../src/schema/snapshots.js';
import { apiKeys, users } from '../../src/schema/users.js';

/**
 * Task 1.6 acceptance: `seed.ts` produces ≈ 200 items across all six sources
 * with 60 days of series, one admin user and one API key (raw value printed by
 * the CLI), and re-running it is idempotent — same report, same rows. All
 * assertions are scoped to the seed's `metadata.seed` marker so the file can
 * share the Testcontainers database with the other integration tests.
 */

const ANCHOR = new Date('2026-10-18T12:00:00Z');
const PEPPER = 'seed-int-test-pepper-0123456789abcdef';
const ADMIN_EMAIL = 'seed-admin@trendr.test';

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

function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

const SEED_MARKER = sql`${items.metadata} ->> 'seed' = 'true'`;

async function seedItemIds(): Promise<bigint[]> {
  const rows = await db.select({ id: items.id }).from(items).where(SEED_MARKER);
  return rows.map((row) => row.id);
}

/** Row counts of everything the seed owns, via the seed item ids. */
async function scopedCounts(): Promise<Record<string, number>> {
  const ids = await seedItemIds();
  const [itemRows, snapshotRows, dailyRows, linkRows] = await Promise.all([
    db.select({ n: count() }).from(items).where(SEED_MARKER),
    db.select({ n: count() }).from(snapshots).where(inArray(snapshots.itemId, ids)),
    db.select({ n: count() }).from(dailyMetrics).where(inArray(dailyMetrics.itemId, ids)),
    db.select({ n: count() }).from(itemTopics).where(inArray(itemTopics.itemId, ids)),
  ]);
  return {
    items: single(itemRows).n,
    snapshots: single(snapshotRows).n,
    dailyMetrics: single(dailyRows).n,
    itemTopics: single(linkRows).n,
  };
}

describe('seed.ts (spec §7.3 bootstrap, task 1.6)', () => {
  let report: SeedReport;

  it('seeds 200 items, 60-day series, an admin user and one verifiable API key', async () => {
    report = await seed(db, { pepper: PEPPER, adminEmail: ADMIN_EMAIL, now: ANCHOR });

    // Fixture bookkeeping from the report itself.
    expect(report.items).toBe(200);
    expect(report.sources).toEqual({
      github: 40,
      npm: 40,
      pypi: 34,
      huggingface: 36,
      arxiv: 26,
      mcp: 24,
    });
    expect(report.apiKey).toMatch(/^dt_live_[0-9A-Za-z]{8}_[0-9A-Za-z]{32}$/);
    expect(report.apiKey.startsWith(`${report.apiKeyPrefix}_`)).toBe(true);
    // 316 cumulative/gauge series × 60 daily rows + 46 hourly tail points each
    // (48 h minus the two exact daily buckets).
    expect(report.snapshots).toBe(33_496);
    // npm 40×60 + PyPI 34×60; HF `downloads` is latest-only (spec §7.3.4).
    expect(report.dailyMetrics).toBe(4_440);
    expect(report.itemTopics).toBeGreaterThan(300);

    // Database truth, scoped to the seed marker.
    const ids = await seedItemIds();
    expect(ids).toHaveLength(200);

    const bySource = await db
      .select({ source: items.source, n: count() })
      .from(items)
      .where(SEED_MARKER)
      .groupBy(items.source);
    expect(Object.fromEntries(bySource.map((row) => [row.source, row.n]))).toEqual(report.sources);

    const counts = await scopedCounts();
    expect(counts.items).toBe(report.items);
    expect(counts.snapshots).toBe(report.snapshots);
    expect(counts.dailyMetrics).toBe(report.dailyMetrics);
    expect(counts.itemTopics).toBe(report.itemTopics);

    // 60 days of daily buckets ending on the anchor day, plus a trailing 48 h
    // hourly tail whose newest point is the last complete hour (anchor − 1 h).
    const windowRow = single(
      await db
        .select({
          min: min(snapshots.capturedAt),
          max: max(snapshots.capturedAt),
        })
        .from(snapshots)
        .where(inArray(snapshots.itemId, ids)),
    );
    expect(windowRow.max?.toISOString()).toBe('2026-10-18T11:00:00.000Z');
    expect(windowRow.min?.toISOString()).toBe('2026-08-20T00:00:00.000Z');

    const hourlyRows = single(
      await db
        .select({ n: count() })
        .from(snapshots)
        .where(
          and(
            inArray(snapshots.itemId, ids),
            sql`(${snapshots.capturedAt} AT TIME ZONE 'UTC')::time <> '00:00:00'`,
          ),
        ),
    );
    expect(hourlyRows.n).toBe(14_536);

    // Admin user + API key: only the HMAC-SHA256(pepper, raw) is stored.
    const admin = single(await db.select().from(users).where(eq(users.email, ADMIN_EMAIL)));
    expect(admin.role).toBe('admin');
    expect(admin.emailVerifiedAt).not.toBeNull();

    const key = single(
      await db.select().from(apiKeys).where(eq(apiKeys.prefix, report.apiKeyPrefix)),
    );
    expect(key.userId).toBe(admin.id);
    expect(key.name).toBe('seed-dev-key');
    expect(key.scopes).toEqual(['read', 'admin']);
    expect(key.revokedAt).toBeNull();
    const expectedHash = createHmac('sha256', PEPPER).update(report.apiKey).digest();
    expect(key.keyHash.equals(expectedHash)).toBe(true);

    // Topics are linked and their counters reflect the seed.
    const countedTopics = single(
      await db
        .select({ n: count() })
        .from(topics)
        .where(sql`${topics.itemCount} > 0`),
    );
    expect(countedTopics.n).toBeGreaterThan(0);

    // Spec §7.3.4: HF `downloads` lives in `latest_metrics` only — there must
    // be no persisted daily series for it.
    const hfDailyRows = single(
      await db
        .select({ n: count() })
        .from(dailyMetrics)
        .innerJoin(items, eq(items.id, dailyMetrics.itemId))
        .where(sql`${items.source} = 'huggingface' AND ${SEED_MARKER}`),
    );
    expect(hfDailyRows.n).toBe(0);

    const hfWithDownloads = single(
      await db
        .select({ n: count() })
        .from(items)
        .where(
          sql`${items.source} = 'huggingface' AND ${SEED_MARKER} AND ${items.latestMetrics} ? 'downloads'`,
        ),
    );
    expect(hfWithDownloads.n).toBe(36);
  }, 180_000);

  it('re-running is idempotent: identical report and identical rows', async () => {
    const before = await scopedCounts();

    const second = await seed(db, { pepper: PEPPER, adminEmail: ADMIN_EMAIL, now: ANCHOR });
    expect(second).toEqual(report);

    expect(await scopedCounts()).toEqual(before);

    // Still exactly one key per prefix and no duplicate admin accounts.
    const keyRows = await db
      .select({ n: count() })
      .from(apiKeys)
      .where(eq(apiKeys.prefix, report.apiKeyPrefix));
    expect(single(keyRows).n).toBe(1);
    const adminRows = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL));
    expect(single(adminRows).n).toBe(1);
  }, 180_000);
});
