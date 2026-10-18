# 0002 — Drizzle over Prisma

- Status: Accepted
- Date: 2026-10-18
- Phase: 0
- Source: TRENDR_SPEC.md §2.2

## Context

The hot queries are window functions, `percentile_cont`, `DISTINCT ON` and partition-pruned
time-range scans; partitioning and Timescale DDL must live in raw SQL migrations. Prisma's query
engine binary, opaque query builder and resistance to non-declarative DDL (`PARTITION BY`) all hurt
here.

## Decision

Use **Drizzle ORM** with plain-SQL migrations under `packages/db/migrations`:

- `drizzle-kit generate` models the ordinary tables (`tablesFilter: ['!snapshots*']` per spec §6.2).
- The partitioned `snapshots` table gets a hand-written migration (`0001_partitions.sql`, Phase 1.2;
  design in ADR-0004).
- `drizzle-zod` reuses the schema for request/response validation where useful.

## Consequences

- No query-engine binary: small images, fast cold start, transparent SQL.
- The `snapshots` TypeScript type is declared in Drizzle while its DDL comes from raw SQL — schema
  diff checks must filter `snapshots*` (Phase 1.1 acceptance).
- Raw SQL in migrations must be reviewed by hand (no generator safety net).
