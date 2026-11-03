import { like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';
import { searchItemsTrigram } from '../../src/repositories/search.repo.js';
import { items } from '../../src/schema/items.js';

/**
 * M-1 acceptance: the §7.5 trigram fallback must be able to use a GIN index.
 * The fallback compares `lower(display_name)`, so the index is functional, and
 * it predicates with the indexable `%>` operator rather than the sequential
 * `word_similarity(...) > 0` function call. The `nxt` → `vercel/next.js` pair
 * (word similarity ≈ 0.29) must still match after the predicate change.
 */

const RUN = `int-m1-${Date.now()}`;
const PREFIX = `${RUN}/`;

let connection: Connection;
let db: Db;

beforeAll(async () => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');
  connection = createDb(databaseUrl);
  db = connection.db;

  await db.insert(items).values([
    {
      source: 'github',
      kind: 'repo',
      externalId: `${PREFIX}vercel/next.js`,
      name: 'next.js',
      displayName: `${PREFIX}vercel/next.js`,
      url: `https://github.com/${PREFIX}vercel/next.js`,
      primaryMetric: 'stars',
    },
    {
      source: 'github',
      kind: 'repo',
      externalId: `${PREFIX}facebook/react`,
      name: 'react',
      displayName: `${PREFIX}facebook/react`,
      url: `https://github.com/${PREFIX}facebook/react`,
      primaryMetric: 'stars',
    },
  ]);
});

afterAll(async () => {
  await db.delete(items).where(like(items.externalId, `${PREFIX}%`));
  await connection.pool.end();
});

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function indexNames(node: PlanNode): string[] {
  const names = node['Index Name'] === undefined ? [] : [node['Index Name']];
  return [...names, ...(node.Plans ?? []).flatMap(indexNames)];
}

describe('trigram search index (M-1)', () => {
  it('declares the functional GIN index on lower(display_name)', async () => {
    const rows = await db.execute<{ indexdef: string }>(sql`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'items'
        AND indexname = 'items_display_name_trgm_idx'`);
    const definition = rows.rows[0]?.indexdef;
    expect(definition).toBeDefined();
    expect(definition).toContain('USING gin');
    expect(definition).toContain('lower(display_name)');
    expect(definition).toContain('gin_trgm_ops');
  });

  it('lets the planner use that index for the fallback predicate', async () => {
    // The test database is orders of magnitude smaller than production, so the
    // planner would always prefer a sequential scan on cost. Disabling it
    // proves the index is *usable* for this predicate, which is the finding.
    // The partial `items_tier_idx` is left out of this shape so the only
    // applicable access path is the trigram index.
    const plan = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL enable_seqscan = off`);
      await tx.execute(sql`SELECT set_config('pg_trgm.word_similarity_threshold', '0.150', true)`);
      const result = await tx.execute<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(sql`
        EXPLAIN (FORMAT JSON)
        SELECT id FROM items
        WHERE NOT (
            search_tsv @@ websearch_to_tsquery('english', 'nxt')
            OR search_tsv @@ websearch_to_tsquery('simple', 'nxt')
          )
          AND lower(display_name) %> lower('nxt')
        ORDER BY word_similarity(lower('nxt'), lower(display_name)) DESC, id DESC
        LIMIT 10`);
      const [entry] = result.rows;
      if (entry === undefined) throw new Error('EXPLAIN returned no plan');
      return entry['QUERY PLAN'][0];
    });

    expect(indexNames(plan.Plan)).toContain('items_display_name_trgm_idx');
  });

  it('still resolves the §18 acceptance pair through the fallback', async () => {
    const rows = await searchItemsTrigram(db, { q: 'nxt', fetch: 5 });
    expect(rows.some((row) => row.displayName === `${PREFIX}vercel/next.js`)).toBe(true);
    expect(rows.every((row) => row.displayName !== `${PREFIX}facebook/react`)).toBe(true);
  });

  it('keeps pg_trgm defaults outside the search transaction', async () => {
    const rows = await db.execute<{ threshold: string }>(sql`
      SELECT current_setting('pg_trgm.word_similarity_threshold') AS threshold`);
    expect(rows.rows[0]?.threshold).toBe('0.6');
  });
});
