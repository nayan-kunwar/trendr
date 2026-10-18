// @trendr/db — Drizzle schema, migrations, repositories (spec §6; Phase 1).
export * from './client.js';
export * from './partitions.js';
export * from './repositories/cards.repo.js';
export * from './repositories/items.repo.js';
export * from './repositories/runs.repo.js';
export * from './repositories/scores.repo.js';
export * from './repositories/series.repo.js';
export * from './repositories/snapshots.repo.js';
export * from './schema/index.js';
// Typing-only declaration; its DDL is hand-written in migrations/0001_partitions.sql.
export * from './schema/snapshots.js';
