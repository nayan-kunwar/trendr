import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { runMigrations } from '@trendr/db/migrate';

/**
 * Shared integration-test fixture (spec §16): one Postgres 16 and one Redis 7
 * per run, all migrations applied before any test executes. The URLs are
 * exported through `process.env`, which Vitest workers inherit.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis = await new RedisContainer('redis:7-alpine').start();

  process.env.DATABASE_URL = postgres.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();

  await runMigrations(process.env.DATABASE_URL);

  return async () => {
    await redis.stop();
    await postgres.stop();
  };
}
