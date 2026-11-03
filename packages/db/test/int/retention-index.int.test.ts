import { sql, type SQL } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb, type Connection, type Db } from '../../src/client.js';

/**
 * M-4 acceptance: the retention pass and Postgres FK checks look rows up by
 * `scores.run_id` and `alert_events.score_run_id`. Both indexes must exist and
 * be usable — the test database is too small for the planner to pick them on
 * cost alone, so `enable_seqscan` is disabled to prove applicability.
 */

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

interface PlanNode {
  'Node Type': string;
  'Index Name'?: string;
  Plans?: PlanNode[];
}

function indexNames(node: PlanNode): string[] {
  const names = node['Index Name'] === undefined ? [] : [node['Index Name']];
  return [...names, ...(node.Plans ?? []).flatMap(indexNames)];
}

async function plannedIndexes(statement: SQL): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL enable_seqscan = off`);
    const result = await tx.execute<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
      sql`EXPLAIN (FORMAT JSON) ${statement}`,
    );
    const [entry] = result.rows;
    if (entry === undefined) throw new Error('EXPLAIN returned no plan');
    return indexNames(entry['QUERY PLAN'][0].Plan);
  });
}

describe('retention lookup indexes (M-4)', () => {
  it('creates both indexes and marks them valid', async () => {
    const rows = await db.execute<{ name: string; valid: boolean }>(sql`
      SELECT c.relname AS name, i.indisvalid AS valid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('scores_run_idx', 'alert_events_score_run_idx')
      ORDER BY c.relname`);
    expect(rows.rows).toEqual([
      { name: 'alert_events_score_run_idx', valid: true },
      { name: 'scores_run_idx', valid: true },
    ]);
  });

  it('lets the planner reach scores by run_id', async () => {
    const names = await plannedIndexes(sql`SELECT 1 FROM scores WHERE run_id = 0`);
    expect(names).toContain('scores_run_idx');
  });

  it('lets the planner reach alert_events by score_run_id', async () => {
    const names = await plannedIndexes(sql`SELECT 1 FROM alert_events WHERE score_run_id = 0`);
    expect(names).toContain('alert_events_score_run_idx');
  });
});
