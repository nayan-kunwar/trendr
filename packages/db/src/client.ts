import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import * as schema from './schema/index.js';

/** Schema-bound Drizzle client used by repositories and wrappers (tasks 1.2+). */
export type Db = NodePgDatabase<typeof schema>;

export interface Connection {
  db: Db;
  pool: Pool;
}

/** Creates a pooled node-postgres connection with the full (non-partitioned) schema bound. */
export function createDb(connectionString: string, poolConfig?: PoolConfig): Connection {
  const pool = new Pool({ connectionString, ...poolConfig });
  return { db: drizzle(pool, { schema }), pool };
}
