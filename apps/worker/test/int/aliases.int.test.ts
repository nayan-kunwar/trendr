import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createDb,
  itemAliases,
  items,
  loadItemTopics,
  topics,
  type Connection,
  type Db,
} from '@trendr/db';
import type { NormalizedItem } from '@trendr/sources';

import { persistNormalizedItems } from '../../src/ingestion/upsert.js';

/**
 * Task 5.6 acceptance — the shared alias resolver handles every §5.4 relation,
 * dedupes repeated targets, skips self-links and creates warm stubs; the same
 * transaction also persists the normalized topic links.
 */

const PREFIX = 'int-alias/';
const OWNER = `${PREFIX}owner`;
const TOPIC = 'int-alias-topic';

const TARGET_ALIASES = [
  {
    source: 'github',
    kind: 'repo',
    externalId: `${PREFIX}same-project`,
    relation: 'same_project',
    confidence: 0.8,
    evidence: 'test.same_project',
  },
  {
    source: 'npm',
    kind: 'package',
    externalId: `${PREFIX}npm-target`,
    relation: 'package_of',
    confidence: 0.9,
    evidence: 'test.package_of',
  },
  {
    source: 'mcp',
    kind: 'mcp_server',
    externalId: `${PREFIX}mcp-target`,
    relation: 'mcp_server_of',
    confidence: 0.95,
    evidence: 'test.mcp_server_of',
  },
  {
    source: 'arxiv',
    kind: 'paper',
    externalId: `${PREFIX}arxiv-target`,
    relation: 'paper_code',
    confidence: 0.9,
    evidence: 'test.paper_code',
  },
  {
    source: 'huggingface',
    kind: 'model',
    externalId: `${PREFIX}hf-target`,
    relation: 'model_of_paper',
    confidence: 0.9,
    evidence: 'test.model_of_paper',
  },
  {
    source: 'pypi',
    kind: 'package',
    externalId: `${PREFIX}pypi-target`,
    relation: 'registry_entry_of',
    confidence: 0.95,
    evidence: 'test.registry_entry_of',
  },
] satisfies NormalizedItem['aliases'];

let connection: Connection;
let db: Db;

function normalized(): NormalizedItem {
  return {
    item: {
      source: 'github',
      kind: 'repo',
      externalId: OWNER,
      upstreamId: OWNER,
      name: 'alias-owner',
      displayName: 'Alias Owner',
      description: 'shared resolver fixture',
      url: `https://github.com/${OWNER}`,
      homepage: null,
      language: 'typescript',
      license: 'MIT',
      owner: 'int-alias',
      topics: [TOPIC],
      primaryMetric: 'stars',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: {},
      flags: [],
    },
    snapshots: [{ metric: 'stars', value: 10 }],
    daily: [],
    aliases: [
      ...TARGET_ALIASES,
      // A self-link must never reach the DB (there is also a CHECK constraint).
      {
        source: 'github',
        kind: 'repo',
        externalId: OWNER,
        relation: 'same_project',
        confidence: 1,
        evidence: 'test.self',
      },
      // The resolver's target map and the unique index both dedupe this row.
      {
        source: 'npm',
        kind: 'package',
        externalId: `${PREFIX}npm-target`,
        relation: 'package_of',
        confidence: 0.9,
        evidence: 'test.package_of',
      },
    ],
  };
}

beforeAll(async () => {
  connection = createDb(process.env.DATABASE_URL ?? '');
  db = connection.db;
  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await connection.pool.end();
});

async function cleanup(): Promise<void> {
  await db.execute(sql`DELETE FROM items WHERE external_id LIKE ${`${PREFIX}%`}`);
  await db.execute(sql`
    DELETE FROM topics
    WHERE slug = ${TOPIC}
      AND NOT EXISTS (SELECT 1 FROM item_topics WHERE topic_id = topics.id)`);
}

describe('shared alias resolver and topic links (spec §7.1 step 5)', () => {
  it('persists all six relations as warm stubs and links the owner topic', async () => {
    await persistNormalizedItems(db, [normalized()], {
      mode: 'snapshot',
      tier: 'warm',
      capturedAt: new Date(),
      runId: null,
      newItemTier: 'warm',
    });

    const [owner] = await db.select().from(items).where(eq(items.externalId, OWNER));
    if (owner === undefined) throw new Error('owner row missing');

    const aliasRows = await db.select().from(itemAliases).where(eq(itemAliases.itemId, owner.id));
    expect(aliasRows).toHaveLength(TARGET_ALIASES.length);
    expect(aliasRows.map((row) => row.relation).sort()).toEqual(
      [...TARGET_ALIASES.map((alias) => alias.relation)].sort(),
    );
    expect(aliasRows.some((row) => row.aliasItemId === owner.id)).toBe(false);

    const targets = await db
      .select()
      .from(items)
      .where(sql`${items.externalId} LIKE ${`${PREFIX}%`} AND ${items.id} <> ${owner.id}`);
    expect(targets).toHaveLength(TARGET_ALIASES.length);
    for (const target of targets) {
      expect(target).toMatchObject({ tier: 'warm', metadata: { aliasStub: true } });
    }

    expect(await loadItemTopics(db, owner.id)).toContain(TOPIC);
    const [topic] = await db.select().from(topics).where(eq(topics.slug, TOPIC));
    expect(topic?.itemCount).toBe(1);

    // Omissions are not deletions: a later payload without topics keeps the link.
    const withoutTopics = normalized();
    await persistNormalizedItems(
      db,
      [{ ...withoutTopics, item: { ...withoutTopics.item, topics: [] }, aliases: [] }],
      { mode: 'snapshot', tier: 'warm', capturedAt: new Date(), runId: null },
    );
    expect(await loadItemTopics(db, owner.id)).toContain(TOPIC);
  });
});
