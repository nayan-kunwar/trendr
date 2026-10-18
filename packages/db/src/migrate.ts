import { Client } from 'pg';

// Placeholder migrator (task 0.7) so the compose `migrate` service completes on
// a fresh database. The real programmatic migrator and drizzle migrations land
// in Phase 1 (tasks 1.1–1.3); this script only proves connectivity.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations');
  process.exit(1);
}

const client = new Client({ connectionString: databaseUrl });
try {
  await client.connect();
  await client.query('SELECT 1');
  console.log('database reachable — migrations land in Phase 1 (task 1.3)');
} catch (error: unknown) {
  console.error('database connection failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
