import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { createDb } from '../../src/client.js';
import { runMigrations } from '../../src/migrate.js';

/**
 * Task 1.3 acceptance (programmatic half): running the migrator again must be a
 * no-op — the drizzle journal stays byte-identical. The compose `migrate`
 * service acceptance (fresh database applies once) is verified against the real
 * stack; see docs/SPEC_REVIEW.md, "Phase 1 notes".
 */
describe('runMigrations re-run', () => {
  it('leaves the journal untouched when everything is already applied', async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL is missing — run through `pnpm test:int`');

    const connection = createDb(databaseUrl, { max: 1 });
    try {
      const selectJournal = () =>
        connection.db.execute<{ id: string; hash: string; created_at: string }>(sql`
          SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id`);

      const before = await selectJournal();
      expect(before.rows.length).toBeGreaterThanOrEqual(2);

      await runMigrations(databaseUrl);

      const after = await selectJournal();
      expect(after.rows).toEqual(before.rows);
    } finally {
      await connection.pool.end();
    }
  });
});
