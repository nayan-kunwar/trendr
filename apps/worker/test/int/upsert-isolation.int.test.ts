import { randomUUID } from 'node:crypto';

import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, items, snapshots, type Connection, type Db } from '@trendr/db';
import type { NormalizedItem } from '@trendr/sources';

import { persistNormalizedItems } from '../../src/ingestion/upsert.js';

/**
 * M-10 acceptance: a chunk is de-duplicated by `(source, external_id)` before
 * the upsert, and if the chunk transaction still fails, each item is retried
 * alone. A deliberately poisoned item may fail on its own, but it must not
 * roll back the rows and snapshots of its neighbours.
 */

const RUN = randomUUID();
const PREFIX = `int-m10-${RUN}/`;
const OWNER = `int-m10-${RUN}`;

let connection: Connection;
let db: Db;

beforeAll(() => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
  connection = createDb(databaseUrl);
  db = connection.db;
});

afterAll(async () => {
  await db.delete(items).where(like(items.externalId, `${PREFIX}%`));
  await connection.pool.end();
});

function normalized(externalId: string, value: number): NormalizedItem {
  return {
    item: {
      source: 'github',
      kind: 'repo',
      externalId,
      upstreamId: `R_${externalId}`,
      name: externalId.slice(OWNER.length + 1),
      displayName: externalId,
      description: null,
      url: `https://github.com/${externalId}`,
      homepage: null,
      language: null,
      license: null,
      owner: OWNER,
      topics: [],
      primaryMetric: 'stars',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: {},
      flags: [],
    },
    snapshots: [{ metric: 'stars', value }],
    daily: [],
    aliases: [],
  };
}

function persist(itemsToPersist: NormalizedItem[]) {
  return persistNormalizedItems(db, itemsToPersist, {
    mode: 'snapshot',
    tier: 'warm',
    capturedAt: new Date(),
    runId: null,
  });
}

describe('chunk de-duplication and isolation (M-10)', () => {
  it('collapses duplicate natural keys into one upsert', async () => {
    const externalId = `${PREFIX}duplicate`;
    const result = await persist([normalized(externalId, 10), normalized(externalId, 20)]);

    expect(result).toEqual({ upserted: 1, failed: 0 });
    const rows = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.source, 'github'), eq(items.externalId, externalId)));
    expect(rows).toHaveLength(1);

    const itemId = rows[0]?.id;
    if (itemId === undefined) throw new Error('deduped item was not persisted');
    const stored = await db
      .select({ value: snapshots.value })
      .from(snapshots)
      .where(eq(snapshots.itemId, itemId));
    expect(stored).toEqual([{ value: 10 }]);
  });

  it('persists the healthy items when one item poisons the chunk', async () => {
    const goodId = `${PREFIX}good`;
    const poisonId = `${PREFIX}poison`;
    const poison = normalized(poisonId, 2);
    poison.daily = [{ metric: 'downloads', day: '2026-11-01', value: -1 }];

    const result = await persist([normalized(goodId, 41), poison]);
    expect(result).toEqual({ upserted: 1, failed: 1 });

    const good = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.source, 'github'), eq(items.externalId, goodId)));
    expect(good).toHaveLength(1);
    const goodItemId = good[0]?.id;
    if (goodItemId === undefined) throw new Error('healthy item was not persisted');
    expect(
      await db
        .select({ value: snapshots.value })
        .from(snapshots)
        .where(eq(snapshots.itemId, goodItemId)),
    ).toEqual([{ value: 41 }]);

    // The poisoned item's own transaction rolled back, so neither its item row
    // nor its invalid daily value survives.
    const poisonRows = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.source, 'github'), eq(items.externalId, poisonId)));
    expect(poisonRows).toEqual([]);
    const daily = await db.execute<{ count: string }>(sql`
      SELECT count(*)::text AS count FROM daily_metrics WHERE item_id = ${goodItemId}
    `);
    expect(daily.rows).toEqual([{ count: '0' }]);
  });
});
