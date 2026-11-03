import { randomUUID } from 'node:crypto';

import { and, eq, inArray, like, or, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';
import {
  applyItemRenames,
  upsertItems,
  type ItemUpsert,
} from '../../src/repositories/items.repo.js';
import { startRun } from '../../src/repositories/runs.repo.js';
import { upsertSnapshots } from '../../src/repositories/snapshots.repo.js';
import { ensureUserForLogin } from '../../src/repositories/users.repo.js';
import { addWatchlistItem, createWatchlist } from '../../src/repositories/watchlists.repo.js';
import {
  alertEvents,
  alerts,
  itemAliases,
  itemTopics,
  items,
  topics,
  users,
  watchlistItems,
  watchlists,
} from '../../src/schema/index.js';
import { ingestionRuns } from '../../src/schema/ops.js';
import { snapshots } from '../../src/schema/snapshots.js';

/**
 * H-4 acceptance: a rename back to a previously used name merges the cold
 * `stub` into the live row instead of leaving it as the upsert target, and a
 * two-item name swap is staged through temporary ids so both renames succeed.
 * The live row id survives, so snapshots, watchlists, topics, alerts and
 * aliases follow the project.
 */

const RUN = randomUUID();
const PREFIX = `int-h4-${RUN}/`;
const EMAIL = `int-h4-${RUN}@example.test`;
const RUN_JOB = `int-h4-${RUN}-run`;
const TOPIC_ONE = `int-h4-${RUN.slice(0, 8)}-one`;
const TOPIC_TWO = `int-h4-${RUN.slice(0, 8)}-two`;

let connection: Connection;
let db: Db;
let userId: string;
let watchlistOne: string;
let watchlistTwo: string;
let topicOne: number;
let topicTwo: number;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
  connection = createDb(databaseUrl);
  db = connection.db;

  const user = await ensureUserForLogin(db, EMAIL, false);
  userId = user.id;
  watchlistOne = (await createWatchlist(db, { userId, name: 'h4-one', isDefault: true })).id;
  watchlistTwo = (await createWatchlist(db, { userId, name: 'h4-two', isDefault: false })).id;
  topicOne = await ensureTopic(TOPIC_ONE);
  topicTwo = await ensureTopic(TOPIC_TWO);
});

afterAll(async () => {
  await cleanup();
  await connection.pool.end();
});

async function cleanup(): Promise<void> {
  await db.delete(items).where(like(items.externalId, `${PREFIX}%`));
  await db.delete(watchlists).where(eq(watchlists.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(ingestionRuns).where(eq(ingestionRuns.jobId, RUN_JOB));
  await db.execute(sql`
    DELETE FROM topics
    WHERE slug IN (${TOPIC_ONE}, ${TOPIC_TWO})
      AND NOT EXISTS (SELECT 1 FROM item_topics WHERE topic_id = topics.id)`);
}

async function ensureTopic(slug: string): Promise<number> {
  await db.insert(topics).values({ slug, name: slug }).onConflictDoNothing();
  const [row] = await db.select({ id: topics.id }).from(topics).where(eq(topics.slug, slug));
  if (row === undefined) throw new Error(`topic ${slug} was not created`);
  return row.id;
}

function itemInput(externalId: string, upstreamId: string): ItemUpsert {
  const [owner = 'int-h4', name = externalId] = externalId.split('/');
  return {
    source: 'github',
    kind: 'repo',
    externalId,
    upstreamId,
    name,
    displayName: externalId,
    description: 'rename fixture',
    url: `https://github.com/${externalId}`,
    homepage: null,
    language: 'typescript',
    license: 'MIT',
    owner,
    primaryMetric: 'stars',
    upstreamCreatedAt: null,
    isArchived: false,
    metadata: {},
  };
}

function capturedAt(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()),
  );
}

function single<T>(rows: T[]): T {
  const [row] = rows;
  if (row === undefined) throw new Error('expected exactly one row');
  return row;
}

async function itemAt(externalId: string) {
  return db
    .select()
    .from(items)
    .where(and(eq(items.source, 'github'), eq(items.externalId, externalId)));
}

describe('rename maintenance (H-4)', () => {
  it('merges the target stub on a rename-back and keeps the live history', async () => {
    const oldId = `${PREFIX}old`;
    const newId = `${PREFIX}new`;
    const otherId = `${PREFIX}other`;
    const upstreamId = `R_${RUN}_live`;
    const captured = capturedAt();

    const [live] = await upsertItems(db, [itemInput(oldId, upstreamId)]);
    const [other] = await upsertItems(db, [itemInput(otherId, `R_${RUN}_other`)]);
    if (live === undefined || other === undefined) throw new Error('fixtures were not created');

    await upsertSnapshots(db, [
      {
        itemId: live.id,
        metric: 'stars',
        capturedAt: captured,
        observedAt: new Date(),
        value: 41,
        runId: null,
      },
    ]);
    await db.insert(itemTopics).values({ itemId: live.id, topicId: topicOne });
    await addWatchlistItem(db, watchlistOne, live.id, new Date());

    // A→B: the live row moves and a cold stub keeps the old name.
    expect(
      await applyItemRenames(db, [
        {
          source: 'github',
          itemId: live.id,
          fromExternalId: oldId,
          toExternalId: newId,
          evidence: 'github_rename',
        },
      ]),
    ).toEqual(['renamed']);

    const stub = single(await itemAt(oldId));
    expect(stub.id).not.toBe(live.id);
    expect(stub.flags).toContain('stub');

    // Users and derived data can attach to the stub while it is the only row
    // carrying the old name. The merge must not orphan or duplicate them.
    await addWatchlistItem(db, watchlistOne, stub.id, new Date());
    await addWatchlistItem(db, watchlistTwo, stub.id, new Date());
    await db.insert(itemTopics).values([
      { itemId: stub.id, topicId: topicOne },
      { itemId: stub.id, topicId: topicTwo },
    ]);
    const [alert] = await db
      .insert(alerts)
      .values({ userId, type: 'velocity_spike', itemId: stub.id })
      .returning();
    if (alert === undefined) throw new Error('alert fixture was not created');
    const runId = await startRun(db, {
      source: 'github',
      jobType: 'snapshot',
      jobId: RUN_JOB,
    });
    const [event] = await db
      .insert(alertEvents)
      .values({
        alertId: alert.id,
        itemId: stub.id,
        scoreRunId: runId,
        dedupeKey: `${alert.id}:${stub.id}:24h:0`,
        payload: {},
      })
      .returning();
    if (event === undefined) throw new Error('alert event fixture was not created');

    await db.insert(itemAliases).values([
      {
        itemId: stub.id,
        aliasItemId: other.id,
        relation: 'same_project',
        confidence: 1,
        evidence: 'stub_to_other',
      },
      {
        itemId: other.id,
        aliasItemId: stub.id,
        relation: 'same_project',
        confidence: 1,
        evidence: 'other_to_stub',
      },
    ]);

    // B→A: this used to return `target-exists`; the following upsert then hit
    // `items_source_upstream_uq` because the live row still owned the node id.
    expect(
      await applyItemRenames(db, [
        {
          source: 'github',
          itemId: live.id,
          fromExternalId: newId,
          toExternalId: oldId,
          evidence: 'github_rename',
        },
      ]),
    ).toEqual(['renamed']);

    // The production path immediately replays the payload that triggered the
    // rename. It must land on the live row, not the deleted stub.
    const [replayed] = await upsertItems(db, [itemInput(oldId, upstreamId)]);
    expect(replayed?.id).toBe(live.id);

    const renamed = single(await itemAt(oldId));
    expect(renamed.id).toBe(live.id);
    expect(renamed.upstreamId).toBe(upstreamId);
    expect(renamed.flags).not.toContain('stub');

    const newStub = single(await itemAt(newId));
    expect(newStub.id).not.toBe(live.id);
    expect(newStub.upstreamId).toBeNull();
    expect(newStub.flags).toEqual(['stub']);
    expect(newStub.tier).toBe('cold');

    const liveSnapshots = await db
      .select({ value: snapshots.value })
      .from(snapshots)
      .where(eq(snapshots.itemId, live.id));
    expect(liveSnapshots).toEqual([{ value: 41 }]);

    const oneRows = await db
      .select({ itemId: watchlistItems.itemId })
      .from(watchlistItems)
      .where(eq(watchlistItems.watchlistId, watchlistOne));
    expect(oneRows).toEqual([{ itemId: live.id }]);

    const twoRows = await db
      .select({ itemId: watchlistItems.itemId })
      .from(watchlistItems)
      .where(eq(watchlistItems.watchlistId, watchlistTwo));
    expect(twoRows).toEqual([{ itemId: live.id }]);

    const liveTopics = await db
      .select({ topicId: itemTopics.topicId })
      .from(itemTopics)
      .where(eq(itemTopics.itemId, live.id))
      .orderBy(itemTopics.topicId);
    expect(liveTopics).toEqual([{ topicId: topicOne }, { topicId: topicTwo }]);
    const stubTopics = await db
      .select({ itemId: itemTopics.itemId })
      .from(itemTopics)
      .where(eq(itemTopics.itemId, stub.id));
    expect(stubTopics).toEqual([]);

    expect(single(await db.select().from(alerts).where(eq(alerts.id, alert.id))).itemId).toBe(
      live.id,
    );
    expect(
      single(await db.select().from(alertEvents).where(eq(alertEvents.id, event.id))).itemId,
    ).toBe(live.id);

    const danglingAliases = await db
      .select({ id: itemAliases.id })
      .from(itemAliases)
      .where(or(eq(itemAliases.itemId, stub.id), eq(itemAliases.aliasItemId, stub.id)));
    expect(danglingAliases).toEqual([]);

    const aliases = await db
      .select({
        itemId: itemAliases.itemId,
        aliasItemId: itemAliases.aliasItemId,
        evidence: itemAliases.evidence,
      })
      .from(itemAliases)
      .where(
        or(
          and(eq(itemAliases.itemId, live.id), eq(itemAliases.aliasItemId, other.id)),
          and(eq(itemAliases.itemId, other.id), eq(itemAliases.aliasItemId, live.id)),
          and(eq(itemAliases.itemId, live.id), eq(itemAliases.aliasItemId, newStub.id)),
        ),
      )
      .orderBy(itemAliases.evidence);
    expect(aliases).toEqual([
      { itemId: live.id, aliasItemId: newStub.id, evidence: 'github_rename' },
      { itemId: other.id, aliasItemId: live.id, evidence: 'other_to_stub' },
      { itemId: live.id, aliasItemId: other.id, evidence: 'stub_to_other' },
    ]);
  });

  it('swaps two names in one batch without creating a stub', async () => {
    const nameA = `${PREFIX}swap-a`;
    const nameB = `${PREFIX}swap-b`;
    const upstreamA = `R_${RUN}_swap_a`;
    const upstreamB = `R_${RUN}_swap_b`;
    const captured = capturedAt();

    const [itemA] = await upsertItems(db, [itemInput(nameA, upstreamA)]);
    const [itemB] = await upsertItems(db, [itemInput(nameB, upstreamB)]);
    if (itemA === undefined || itemB === undefined) throw new Error('swap fixtures missing');

    await upsertSnapshots(db, [
      {
        itemId: itemA.id,
        metric: 'stars',
        capturedAt: captured,
        observedAt: new Date(),
        value: 11,
        runId: null,
      },
      {
        itemId: itemB.id,
        metric: 'stars',
        capturedAt: captured,
        observedAt: new Date(),
        value: 22,
        runId: null,
      },
    ]);

    // Both targets are occupied by the other moving row; sequential renames
    // see `target-exists`, so the batch must stage both through temporary ids.
    expect(
      await applyItemRenames(db, [
        {
          source: 'github',
          itemId: itemA.id,
          fromExternalId: nameA,
          toExternalId: nameB,
          evidence: 'github_rename',
        },
        {
          source: 'github',
          itemId: itemB.id,
          fromExternalId: nameB,
          toExternalId: nameA,
          evidence: 'github_rename',
        },
      ]),
    ).toEqual(['renamed', 'renamed']);

    const atA = single(await itemAt(nameA));
    const atB = single(await itemAt(nameB));
    expect(atA.id).toBe(itemB.id);
    expect(atA.upstreamId).toBe(upstreamB);
    expect(atB.id).toBe(itemA.id);
    expect(atB.upstreamId).toBe(upstreamA);

    const stubs = await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.source, 'github'),
          inArray(items.externalId, [nameA, nameB]),
          sql`'stub' = ANY(${items.flags})`,
        ),
      );
    expect(stubs).toEqual([]);

    const values = await db
      .select({ itemId: snapshots.itemId, value: snapshots.value })
      .from(snapshots)
      .where(inArray(snapshots.itemId, [itemA.id, itemB.id]));
    expect(values).toHaveLength(2);
    expect(single(values.filter((row) => row.itemId === itemA.id)).value).toBe(11);
    expect(single(values.filter((row) => row.itemId === itemB.id)).value).toBe(22);

    // Replaying both payloads after the swap must find the moved rows.
    const upserted = await upsertItems(db, [
      itemInput(nameB, upstreamA),
      itemInput(nameA, upstreamB),
    ]);
    expect(upserted).toEqual(
      expect.arrayContaining([
        { id: itemA.id, source: 'github', externalId: nameB },
        { id: itemB.id, source: 'github', externalId: nameA },
      ]),
    );
  });

  it('keeps a chain live and only stubs the vacated head', async () => {
    const nameA = `${PREFIX}chain-a`;
    const nameB = `${PREFIX}chain-b`;
    const nameC = `${PREFIX}chain-c`;

    const [first] = await upsertItems(db, [itemInput(nameA, `R_${RUN}_chain_a`)]);
    const [second] = await upsertItems(db, [itemInput(nameB, `R_${RUN}_chain_b`)]);
    if (first === undefined || second === undefined) throw new Error('chain fixtures missing');

    expect(
      await applyItemRenames(db, [
        {
          source: 'github',
          itemId: first.id,
          fromExternalId: nameA,
          toExternalId: nameB,
          evidence: 'github_rename',
        },
        {
          source: 'github',
          itemId: second.id,
          fromExternalId: nameB,
          toExternalId: nameC,
          evidence: 'github_rename',
        },
      ]),
    ).toEqual(['renamed', 'renamed']);

    expect(single(await itemAt(nameB)).id).toBe(first.id);
    expect(single(await itemAt(nameC)).id).toBe(second.id);
    const nameAStub = single(await itemAt(nameA));
    expect(nameAStub.flags).toContain('stub');
    const nameBRows = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.source, 'github'), eq(items.externalId, nameB)));
    expect(nameBRows).toEqual([{ id: first.id }]);
  });
});
