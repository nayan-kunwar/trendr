import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer } from 'testcontainers';
import { runMigrations } from '@trendr/db/migrate';

/**
 * Shared integration-test fixture (spec §16): one Postgres 16, Redis 7 and
 * Mailpit per run, all migrations applied before any test executes. The URLs
 * are exported through `process.env`, which Vitest workers inherit.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const postgres = await new PostgreSqlContainer('postgres:16-alpine').start();
  const redis = await new RedisContainer('redis:7-alpine').start();
  const mailpit = await new GenericContainer('axllent/mailpit:latest')
    .withExposedPorts(1025, 8025)
    .start();

  process.env.DATABASE_URL = postgres.getConnectionUri();
  process.env.REDIS_URL = redis.getConnectionUrl();
  process.env.SMTP_URL = `smtp://${mailpit.getHost()}:${mailpit.getMappedPort(1025)}`;
  process.env.MAILPIT_URL = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;

  await runMigrations(process.env.DATABASE_URL);

  return async () => {
    await mailpit.stop();
    await redis.stop();
    await postgres.stop();
  };
}
