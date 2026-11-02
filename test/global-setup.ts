import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { GenericContainer } from 'testcontainers';
import { createDb, ensurePartitions } from '@trendr/db';
import { runMigrations } from '@trendr/db/migrate';

/**
 * Fixed anchors in the integration suite start at 2026-08-20 (60-day seed
 * series ending 2026-10-18). Migrations only create the current month −2/+3
 * window, so as the calendar advances those historical rows would land in
 * `snapshots_default` and break the ISS-7 invariant. Create the months from a
 * floor before the earliest fixture so every fixed date has a real partition.
 */
async function ensureFixturePartitions(databaseUrl: string): Promise<void> {
  const now = new Date();
  const fixtureFloor = new Date('2026-08-01T00:00:00Z');
  const monthsBack = Math.max(
    0,
    (now.getUTCFullYear() - fixtureFloor.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - fixtureFloor.getUTCMonth()),
  );

  const connection = createDb(databaseUrl, { max: 1 });
  try {
    await ensurePartitions(connection.db, monthsBack, 3);
  } finally {
    await connection.pool.end();
  }
}

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
  await ensureFixturePartitions(process.env.DATABASE_URL);

  return async () => {
    await mailpit.stop();
    await redis.stop();
    await postgres.stop();
  };
}
