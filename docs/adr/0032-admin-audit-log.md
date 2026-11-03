# ADR-0032 — Admin audit log

- Status: Accepted (Phase 6)
- Date: 2026-11-03
- Spec: §10.1 (admin endpoints), §6.2 (ops tables)
- Finding: M-6

## Context

The admin API can trigger ingestion and scoring, replay or discard dead-letter
jobs and patch an item's tier/flags. Nothing recorded who did what: the only
trace was `app.log`, which is rotated and not queryable after the fact. For an
operator surface that can change ingestion behaviour and item visibility, that
is not enough to answer "who hid this item?" or "who replayed that job?".

## Decision

1. **Table.** `admin_audit_log` (`migrations/0007_admin_audit_log.sql`):
   `id` identity, `actor_user_id` (FK `users.id`, `ON DELETE SET NULL`),
   `action`, `target`, `payload jsonb`, `created_at`. Indexed by `created_at`
   and `(actor_user_id, created_at)`; write-only for now (no API yet).

2. **Stable action names.** `item.patch`, `ingest.trigger`, `score.trigger`,
   `dlq.retry`, `dlq.discard`. `target` is the item id, job id, or the requested
   source (`github`/`all`). `payload` carries the request plus the result
   (e.g. the applied tier and flags).

3. **Atomic where it can be.** `patchItemAdmin` accepts an optional audit entry
   and runs the update plus the audit insert in one transaction, so a failed
   patch writes nothing. The queue actions cannot be transactional with Redis:
   the audit row is written immediately after the enqueue/removal succeeds, and
   a failure there fails the request (`500`) rather than silently dropping the
   trail.

4. **Actor.** The admin routes pass `request.authUser?.id`; `null` means the
   call came from a non-user context (tests/CLI) and still gets a row.

## Consequences

- Every mutation from the HTTP admin surface is attributable and durable,
  including after the account is deleted.
- A queue action that succeeds and then fails to audit returns an error; the
  operation itself is idempotent enough to retry (deterministic job ids,
  DLQ replay counter).
- The table grows with operator actions only; no retention job is needed at
  this scale, and the indexes keep both "recent" and "by actor" cheap.
- No read endpoint is added; `psql`/the admin runbook can query it directly. A
  read API can be layered on later without changing the write path.

## Verification

- `apps/api/test/int/admin.int.test.ts`: a successful patch writes one row with
  the actor, action, target and requested payload; a `404` patch writes nothing;
  a score trigger writes `score.trigger` with `target='github'`.
