import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Task 1.1 acceptance: `0000_init.sql` applies cleanly on a fresh Postgres 16
 * (the shared global setup runs the real migrator) and the result matches the
 * spec §6.2 shape — tables, enum labels, the stored generated column, the
 * partial indexes and the named constraints.
 */

const TABLES_FROM_0000 = [
  'alert_events',
  'alerts',
  'api_keys',
  'auth_tokens',
  'daily_metrics',
  'digest_sends',
  'digest_subscriptions',
  'ingestion_runs',
  'item_aliases',
  'item_topics',
  'items',
  'outbox_events',
  'score_runs_current',
  'scores',
  'topics',
  'users',
  'watchlist_items',
  'watchlists',
];

describe('0000_init.sql on a fresh PG16', () => {
  let client: Client;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  it('ran through the drizzle journal exactly once', async () => {
    const result = await client.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    expect(Number(result.rows[0]?.count)).toBe(1);
  });

  it('created every table from spec 6.2', async () => {
    const result = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const created = result.rows.map((row) => row.table_name);
    expect(created).toEqual(expect.arrayContaining(TABLES_FROM_0000));
  });

  it('created the required extensions', async () => {
    const result = await client.query<{ extname: string }>('SELECT extname FROM pg_extension');
    const extensions = result.rows.map((row) => row.extname);
    expect(extensions).toEqual(expect.arrayContaining(['pg_trgm', 'citext', 'pgcrypto']));
  });

  it('created the enum types with the spec §5 labels', async () => {
    const result = await client.query<{ typname: string; enumlabel: string }>(
      `SELECT t.typname, e.enumlabel
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       ORDER BY t.typname, e.enumsortorder`,
    );
    const labels = new Map<string, string[]>();
    for (const row of result.rows) {
      labels.set(row.typname, [...(labels.get(row.typname) ?? []), row.enumlabel]);
    }

    expect(labels.get('source_t')).toEqual([
      'github',
      'npm',
      'pypi',
      'huggingface',
      'arxiv',
      'mcp',
    ]);
    expect(labels.get('window_t')).toEqual(['24h', '7d', '30d']);
    expect(labels.get('tier_t')).toEqual(['hot', 'warm', 'cold', 'archived']);
    expect(labels.get('metric_t')).toEqual([
      'stars',
      'forks',
      'watchers',
      'open_issues',
      'downloads',
      'downloads_total',
      'likes',
      'upvotes',
      'trending_score',
      'comments',
    ]);
    expect(labels.get('item_kind_t')).toHaveLength(7);
    expect(labels.get('run_status_t')).toHaveLength(6);
  });

  it('marks items.search_tsv as a stored generated column', async () => {
    const result = await client.query<{ attgenerated: string }>(
      `SELECT attgenerated FROM pg_attribute
       WHERE attrelid = 'items'::regclass AND attname = 'search_tsv'`,
    );
    expect(result.rows[0]?.attgenerated).toBe('s');
  });

  it('created the partial and expression indexes from spec 6.2', async () => {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    );
    const defs = new Map(result.rows.map((row) => [row.indexname, row.indexdef]));

    expect(defs.get('items_source_upstream_uq')).toContain('WHERE (upstream_id IS NOT NULL)');
    expect(defs.get('items_tier_idx')).toContain('WHERE (NOT is_deleted)');
    expect(defs.get('items_search_idx')).toContain('USING gin (search_tsv)');
    expect(defs.get('items_name_trgm_idx')).toContain('gin_trgm_ops');
    expect(defs.get('scores_board_idx')).toContain('final_score DESC');
    expect(defs.get('watchlists_one_default')).toContain('WHERE is_default');
    expect(defs.get('outbox_unpublished_idx')).toContain('WHERE (published_at IS NULL)');
  });

  it('created the named constraints from spec 6.2', async () => {
    const result = await client.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace`,
    );
    const names = result.rows.map((row) => row.conname);
    expect(names).toEqual(
      expect.arrayContaining([
        'alerts_target_ck',
        'api_keys_user_name_uq',
        'digest_sends_uq',
        'ingestion_runs_job_attempt_uq',
        'item_aliases_no_self',
        'items_source_external_uq',
        'watchlists_user_name_uq',
      ]),
    );
  });
});
