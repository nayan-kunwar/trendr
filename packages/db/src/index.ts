// @trendr/db — Drizzle schema, migrations, repositories (spec §6; Phase 1).
export * from './client.js';
export * from './partitions.js';
export * from './schema/index.js';
// Typing-only declaration; its DDL is hand-written in migrations/0001_partitions.sql.
export * from './schema/snapshots.js';
