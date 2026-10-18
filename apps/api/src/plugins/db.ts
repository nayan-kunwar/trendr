import fp from 'fastify-plugin';

import type { Connection, Db } from '@trendr/db';

declare module 'fastify' {
  interface FastifyInstance {
    /** Schema-bound Drizzle client (spec §4). */
    db: Db;
    /** The node-postgres pool behind `db` (health probes, raw statements). */
    pool: Connection['pool'];
  }
}

export interface DbPluginOptions {
  /** Caller-owned connection: main.ts builds it from env, tests from Testcontainers. */
  connection: Connection;
}

/** Decorates `app.db` + `app.pool` (spec §4). Lifetime stays with the caller. */
export const registerDb = fp<DbPluginOptions>(
  (app, { connection }) => {
    app.decorate('db', connection.db);
    app.decorate('pool', connection.pool);
  },
  { name: 'db' },
);
