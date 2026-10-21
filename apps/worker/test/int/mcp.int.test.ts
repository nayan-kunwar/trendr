import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Source } from '@trendr/core';
import {
  createDb,
  dailyMetrics,
  itemAliases,
  items,
  loadItemTopics,
  upsertDailyMetrics,
  upsertSnapshots,
  type Connection,
  type Db,
} from '@trendr/db';
import type { NormalizedItem } from '@trendr/sources';

import {
  findLinkedMcpAliasTargets,
  loadMcpDerivedMetrics,
} from '../../src/ingestion/mcp-derived.js';
import { persistNormalizedItems } from '../../src/ingestion/upsert.js';

/**
 * Task 5.5 acceptance — alias persistence creates warm target rows, MCP
 * snapshots copy alias stars/downloads through `loadDerivedMetrics`, derived
 * payloads preserve discovery metadata, and registry deletes are sticky.
 */

const PREFIX = 'int-mcp/';
const REPO = `${PREFIX}code-repo`;
const NPM = `${PREFIX}npm-pkg`;
const COLD_REPO = `${PREFIX}cold-repo`;
const ITEM = `${PREFIX}registry-server`;
const DELETED = `${PREFIX}deleted-server`;
const DAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let connection: Connection;
let db: Db;

function mcpItem(externalId: string, overrides: Partial<NormalizedItem['item']> = {}) {
  return {
    source: 'mcp' as const,
    kind: 'mcp_server' as const,
    externalId,
    upstreamId: externalId,
    name: 'registry-server',
    displayName: 'Registry Server',
    description: 'discovery description',
    url: `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(externalId)}/versions/latest`,
    homepage: 'https://example.test',
    language: null,
    license: null,
    owner: 'int-mcp',
    topics: ['mcp'],
    primaryMetric: 'stars' as const,
    upstreamCreatedAt: new Date('2026-01-01T00:00:00Z'),
    isArchived: false,
    metadata: { registryStatus: 'active', marker: 'keep-me' },
    flags: [],
    ...overrides,
  };
}

function normalized(overrides: Partial<NormalizedItem> = {}): NormalizedItem {
  return {
    item: mcpItem(ITEM),
    snapshots: [],
    daily: [],
    aliases: [
      {
        source: 'github',
        kind: 'repo',
        externalId: REPO,
        relation: 'mcp_server_of',
        confidence: 0.95,
        evidence: 'mcp.registry.repository',
      },
      {
        source: 'npm',
        kind: 'package',
        externalId: NPM,
        relation: 'registry_entry_of',
        confidence: 0.95,
        evidence: 'mcp.registry.packages',
      },
      {
        source: 'github',
        kind: 'repo',
        externalId: COLD_REPO,
        relation: 'mcp_server_of',
        confidence: 0.9,
        evidence: 'mcp.registry.repository',
      },
    ],
    ...overrides,
  };
}

function githubNormalized(externalId: string): NormalizedItem {
  return {
    item: {
      source: 'github',
      kind: 'repo',
      externalId,
      upstreamId: null,
      name: 'cold-repo',
      displayName: externalId,
      description: 'pre-existing cold repo',
      url: `https://github.com/${externalId}`,
      homepage: null,
      language: 'typescript',
      license: 'MIT',
      owner: 'int-mcp',
      topics: [],
      primaryMetric: 'stars',
      upstreamCreatedAt: null,
      isArchived: false,
      metadata: { marker: 'existing' },
      flags: [],
    },
    snapshots: [],
    daily: [],
    aliases: [],
  };
}

async function itemByExternalId(externalId: string, source: Source = 'mcp') {
  const [row] = await db
    .select()
    .from(items)
    .where(and(eq(items.source, source), eq(items.externalId, externalId)));
  return row ?? null;
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
  await db.execute(sql`
    DELETE FROM item_aliases
    WHERE item_id IN (
      SELECT id FROM items
      WHERE external_id LIKE ${`${PREFIX}%`}
         OR external_id LIKE ${`github:${PREFIX}%`}
         OR external_id LIKE ${`npm:${PREFIX}%`}
    )
    OR alias_item_id IN (
      SELECT id FROM items
      WHERE external_id LIKE ${`${PREFIX}%`}
         OR external_id LIKE ${`github:${PREFIX}%`}
         OR external_id LIKE ${`npm:${PREFIX}%`}
    )`);
  await db.execute(sql`
    DELETE FROM items
    WHERE external_id LIKE ${`${PREFIX}%`}
       OR external_id LIKE ${`github:${PREFIX}%`}
       OR external_id LIKE ${`npm:${PREFIX}%`}`);
}

describe('MCP alias persistence and derived snapshots (spec §7.3.6)', () => {
  it('creates warm alias targets and copies their stars/downloads into the MCP item', async () => {
    await persistNormalizedItems(db, [githubNormalized(COLD_REPO)], {
      mode: 'snapshot',
      tier: 'cold',
      capturedAt: new Date(),
      runId: null,
      newItemTier: 'cold',
    });

    const inserted = await persistNormalizedItems(db, [normalized()], {
      mode: 'snapshot',
      tier: 'warm',
      capturedAt: new Date(),
      runId: null,
      newItemTier: 'warm',
    });
    expect(inserted).toBe(1);

    const mcp = await itemByExternalId(ITEM);
    expect(mcp).not.toBeNull();
    const github = await itemByExternalId(REPO, 'github');
    const npm = await itemByExternalId(NPM, 'npm');
    const cold = await itemByExternalId(COLD_REPO, 'github');
    expect(github).toMatchObject({ tier: 'warm', metadata: { aliasStub: true } });
    expect(npm).toMatchObject({ tier: 'warm', metadata: { aliasStub: true } });
    expect(cold).toMatchObject({ tier: 'warm', metadata: { marker: 'existing' } });
    if (mcp === null || github === null || npm === null) throw new Error('missing alias rows');

    const aliasRows = await db.select().from(itemAliases).where(eq(itemAliases.itemId, mcp.id));
    expect(aliasRows).toHaveLength(3);
    expect(aliasRows.map((row) => row.relation).sort()).toEqual([
      'mcp_server_of',
      'mcp_server_of',
      'registry_entry_of',
    ]);
    expect(await loadItemTopics(db, mcp.id)).toContain('mcp');

    await upsertSnapshots(
      db,
      [
        {
          itemId: github.id,
          metric: 'stars',
          capturedAt: new Date(),
          observedAt: new Date(),
          value: 777,
          runId: null,
        },
      ],
      { refreshAggregates: true },
    );
    await upsertDailyMetrics(
      db,
      [
        { itemId: npm.id, metric: 'downloads', day: YESTERDAY, value: 40 },
        { itemId: npm.id, metric: 'downloads', day: DAY, value: 50 },
      ],
      { refreshAggregates: true },
    );

    const derived = await loadMcpDerivedMetrics(db, [
      { source: 'mcp', kind: 'mcp_server', externalId: ITEM, itemId: mcp.id },
    ]);
    expect(derived.get(ITEM)).toEqual({
      latest: { stars: 777, downloads: 50 },
      daily: [
        { metric: 'downloads', day: YESTERDAY, value: 40 },
        { metric: 'downloads', day: DAY, value: 50 },
      ],
    });

    const linked = await findLinkedMcpAliasTargets(db, [
      { source: 'github', externalId: REPO },
      { source: 'npm', externalId: NPM },
    ]);
    expect(linked).toEqual(new Set([`github:${REPO}`, `npm:${NPM}`]));

    await persistNormalizedItems(
      db,
      [
        {
          item: mcpItem(ITEM, {
            description: null,
            homepage: null,
            name: 'leaked-name',
            displayName: 'Leaked Name',
            // A derived snapshot with no stars must not downgrade the item.
            primaryMetric: 'downloads',
            metadata: {},
          }),
          snapshots: [{ metric: 'stars', value: 777 }],
          daily: derived.get(ITEM)?.daily ?? [],
          aliases: [],
        },
      ],
      {
        mode: 'snapshot',
        tier: 'hot',
        capturedAt: new Date(),
        runId: null,
        preserveMetadata: true,
      },
    );

    const after = await itemByExternalId(ITEM);
    expect(after).toMatchObject({
      name: 'registry-server',
      displayName: 'Registry Server',
      description: 'discovery description',
      homepage: 'https://example.test',
      primaryMetric: 'stars',
      latestMetrics: { stars: 777, downloads: 50 },
    });
    const mcpDaily = await db
      .select({ day: dailyMetrics.day, value: dailyMetrics.value })
      .from(dailyMetrics)
      .where(eq(dailyMetrics.itemId, mcp.id))
      .orderBy(dailyMetrics.day);
    expect(mcpDaily).toEqual([
      { day: YESTERDAY, value: 40 },
      { day: DAY, value: 50 },
    ]);
  });

  it('marks registry deletes and never resurrects them on a later active payload', async () => {
    await persistNormalizedItems(db, [{ ...normalized(), item: mcpItem(DELETED), aliases: [] }], {
      mode: 'snapshot',
      tier: 'warm',
      capturedAt: new Date(),
      runId: null,
      newItemTier: 'warm',
    });
    const active = await itemByExternalId(DELETED);
    if (active === null) throw new Error('expected active item');

    await persistNormalizedItems(
      db,
      [
        {
          ...normalized(),
          item: mcpItem(DELETED, { isArchived: true }),
          aliases: [],
          deleted: true,
        },
      ],
      { mode: 'snapshot', tier: 'warm', capturedAt: new Date(), runId: null },
    );
    const deleted = await itemByExternalId(DELETED);
    expect(deleted).toMatchObject({ isDeleted: true, isArchived: true });

    await persistNormalizedItems(db, [{ ...normalized(), item: mcpItem(DELETED), aliases: [] }], {
      mode: 'snapshot',
      tier: 'warm',
      capturedAt: new Date(),
      runId: null,
    });
    const stillDeleted = await itemByExternalId(DELETED);
    expect(stillDeleted).toMatchObject({ isDeleted: true, isArchived: false });
  });
});
