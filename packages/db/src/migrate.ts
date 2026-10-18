import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate as applyMigrations } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

/**
 * Programmatic migrator (spec tasks 1.1/1.3): applies every pending SQL file in
 * `migrations/` via drizzle's journal. The folder sits next to the build output in
 * every layout we ship — source checkout (`src/../migrations`), tsup output
 * (`dist/../migrations`) and the pnpm-deploy image
 * (`node_modules/@trendr/db/{dist,migrations}` — reached there through the
 * `packages/db` symlink the Dockerfile creates).
 */
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

export async function runMigrations(databaseUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await applyMigrations(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

/**
 * `node dist/migrate.js` detection that survives symlinks: the compose `migrate`
 * service executes the script through `packages/db/dist/migrate.js`, while Node
 * resolves `import.meta.url` to the real path under `node_modules/@trendr/db`.
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required to run migrations');
    process.exit(1);
  }
  try {
    await runMigrations(databaseUrl);
    console.log('migrations applied');
  } catch (error) {
    console.error('migration failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
