import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  authTokens,
  createDb,
  dailyMetrics,
  ensureUserForLogin,
  ingestionRuns,
  items,
  snapshots,
  upsertItems,
  users,
  type Connection,
  type Db,
} from '@trendr/db';

import {
  previousUtcDay,
  runMaintenanceJob,
  type MaintenanceProcessorOptions,
} from '../../src/processors/maintenance.processor.js';

/**
 * Task 9.4 acceptance — the four background maintenance jobs run against real
 * Postgres: partitions exist and report zero default rows, a previous-day
 * snapshot is rolled up, retention removes an unreferenced old run, and
 * expired auth tokens are deleted.
 */

const PREFIX = 'int-maintenance/';
const EMAIL = 'int-maintenance@example.test';
const NOW = new Date('2026-10-20T12:00:00Z');

let connection: Connection;
let db: Db;
let itemId: bigint;
let userId: string;

function options(extra: Partial<MaintenanceProcessorOptions> = {}): MaintenanceProcessorOptions {
  return {
    db,
    connection: {} as never,
    now: () => NOW,
    ...extra,
  };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is missing');
  connection = createDb(process.env.DATABASE_URL, { max: 2 });
  db = connection.db;
  await cleanup();

  const [item] = await upsertItems(db, [
    {
      source: 'github',
      kind: 'repo',
      externalId: `${PREFIX}rollup`,
      upstreamId: `${PREFIX}rollup`,
      name: 'rollup',
      displayName: 'Maintenance rollup fixture',
      description: null,
      url: `https://github.com/${PREFIX}rollup`,
      homepage: null,
      language: 'typescript',
      license: 'MIT',
      owner: 'int-maintenance',
      primaryMetric: 'stars',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: {},
    },
  ]);
  if (item === undefined) throw new Error('failed to create maintenance fixture');
  itemId = item.id;
  await db.insert(snapshots).values({
    itemId,
    metric: 'stars',
    capturedAt: new Date('2026-10-19T10:00:00Z'),
    observedAt: new Date('2026-10-19T10:00:00Z'),
    value: 123,
  });

  const user = await ensureUserForLogin(db, EMAIL, false);
  userId = user.id;
});

afterAll(async () => {
  await cleanup();
  await connection.pool.end();
});

async function cleanup(): Promise<void> {
  await db.delete(users).where(eq(users.email, EMAIL));
  await db.delete(items).where(eq(items.externalId, `${PREFIX}rollup`));
}

describe('maintenance processor (spec §7.10)', () => {
  it('creates partitions and reports the default partition gauge', async () => {
    const rows: number[] = [];
    const lead: number[] = [];
    const result = await runMaintenanceJob(
      options({
        metrics: {
          setSnapshotsDefaultRows: (value) => rows.push(value),
          setPartitionLeadDays: (value) => lead.push(value),
        },
      }),
      { type: 'create-partitions' },
    );
    expect(result).toMatchObject({ type: 'create-partitions', defaultRows: 0 });
    expect(rows).toEqual([0]);
    // M-11: twelve months ahead, so the newest partition ends ~13 months out.
    expect(result.leadDays).toBeGreaterThan(300);
    expect(lead).toEqual([result.leadDays]);
  });

  it('rolls up the previous UTC day idempotently', async () => {
    expect(previousUtcDay(NOW)).toBe('2026-10-19');
    const first = await runMaintenanceJob(options(), { type: 'rollup-daily' });
    expect(first).toMatchObject({ type: 'rollup-daily', day: '2026-10-19' });
    expect(first.rolledUpRows).toBeGreaterThanOrEqual(1);

    const rows = await db
      .select({ value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(eq(dailyMetrics.itemId, itemId));
    expect(rows).toContainEqual({ value: 123 });

    const second = await runMaintenanceJob(options(), { type: 'rollup-daily' });
    expect(second.rolledUpRows).toBe(first.rolledUpRows);
  });

  it('prunes unreferenced old ingestion runs and expired tokens', async () => {
    await db.insert(ingestionRuns).values({
      source: null,
      jobType: 'maintenance',
      jobId: `${PREFIX}old-run`,
      status: 'succeeded',
      startedAt: new Date('2026-08-01T00:00:00Z'),
      finishedAt: new Date('2026-08-01T00:00:01Z'),
    });
    await db.insert(authTokens).values({
      userId,
      kind: 'magic_link',
      tokenHash: Buffer.from(`${PREFIX}expired-token`),
      expiresAt: new Date('2026-10-01T00:00:00Z'),
    });

    // L-10: `daily_metrics` older than the 400-day horizon is pruned.
    await db.insert(dailyMetrics).values({
      itemId,
      metric: 'downloads',
      day: '2025-01-01',
      value: 5,
    });

    const retained = await runMaintenanceJob(options(), { type: 'retention' });
    expect(retained).toMatchObject({ type: 'retention' });
    expect(retained.deletedIngestionRuns).toBeGreaterThanOrEqual(1);
    expect(retained.deletedDailyMetrics).toBeGreaterThanOrEqual(1);

    const oldDaily = await db
      .select({ day: dailyMetrics.day })
      .from(dailyMetrics)
      .where(and(eq(dailyMetrics.itemId, itemId), eq(dailyMetrics.day, '2025-01-01')));
    expect(oldDaily).toEqual([]);

    const runs = await db
      .select({ id: ingestionRuns.id })
      .from(ingestionRuns)
      .where(eq(ingestionRuns.jobId, `${PREFIX}old-run`));
    expect(runs).toHaveLength(0);

    const cleaned = await runMaintenanceJob(options(), { type: 'cleanup-tokens' });
    expect(cleaned.deletedTokens).toBeGreaterThanOrEqual(1);

    const tokens = await db
      .select({ id: authTokens.id })
      .from(authTokens)
      .where(eq(authTokens.userId, userId));
    expect(tokens).toHaveLength(0);
  });
});
