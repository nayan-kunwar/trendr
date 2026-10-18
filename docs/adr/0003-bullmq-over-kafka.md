# 0003 — BullMQ over Kafka (and RabbitMQ)

- Status: Accepted
- Date: 2026-10-18
- Phase: 0
- Source: TRENDR_SPEC.md §2.3

## Context

The workload is **task scheduling with retries**: cron-like ingest/scoring schedules, delayed jobs,
per-queue concurrency, global rate limiting and a dead-letter queue for adapters. Throughput is on
the order of 10^5 jobs/day. Redis is already required for cache, rate-limit buckets and pub/sub.
Kafka would add a cluster for a stream shape that is not yet needed; RabbitMQ adds another broker
for semantics BullMQ serves better on the datastore we already run.

## Decision

Use **BullMQ on the existing Redis 7** (`--maxmemory-policy noeviction`).

- Job schedulers provide the cron; per-queue `concurrency` and `limiter` provide scheduling and
  upstream-rate protection; retries/backoff and the DLQ are built in.
- The worker process hosts queue processors behind `WORKER_ROLES`.

## Consequences

- One datastore to operate; free-tier friendly deployment (spec §2.3 table).
- No event-log replay: domain events use Redis pub/sub (`events:leaderboard`). If replay or
  analytics become a requirement, the transactional-outbox → RabbitMQ stretch (§19.1) is the
  documented path.
