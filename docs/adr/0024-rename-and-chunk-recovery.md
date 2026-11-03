# ADR-0024 — Rename maintenance and chunk failure isolation

- Status: Accepted (Phase 3)
- Date: 2026-11-03
- Spec: §5.4 (renames), §7.1 (ingestion)
- Findings: H-4, M-10

## Context

Spec §5.4 keeps the old name of a renamed project as an alias. The
implementation does that by moving the live `items` row to the new
`external_id` and inserting a cold `flags=['stub']` row at the old name. The
stub deliberately has `upstream_id = NULL`: the live row keeps the stable node
id.

Two cases break that model:

1. **Rename-back.** After A→B, the stub at A owns the old name. A later B→A
   finds that stub as the target and returns `target-exists`. The following
   `(source, external_id)` upsert then updates the stub's `upstream_id` to the
   node id the live row still holds. The partial unique index
   `items_source_upstream_uq` raises `23505` and the whole chunk transaction
   rolls back. Every retry repeats the failure, so one renaming project
   poisons every other item in its chunk.
2. **Swap or chain.** Two items exchanging names (A→B and B→A) each see the
   other's live row as an occupied target. Sequential renames cannot make
   progress without a staging step.

Separately (M-10), one chunk was one transaction with no de-duplication. Two
normalized entries for the same `(source, external_id)` make `INSERT ... ON
CONFLICT DO UPDATE` fail with "cannot affect row a second time", and any single
bad item rolls back the snapshots, aliases and topics of every other item in
the chunk.

## Decision

### 1. Batch renames and stage moving rows

`applyItemRenames` applies all renames from one source group in one
transaction:

- Load and lock every moving row by `item_id`, in id order.
- Settle the staging set first: a target held by a live row that is not itself
  moving is a genuine conflict (`target-exists`); when one move is blocked, a
  later move into its name is blocked too.
- Move every surviving row to a temporary `external_id`
  (`__trendr_rename_<uuid>`). This frees all source names before any target is
  written, which makes swaps (A→B, B→A) and chains (A→B, B→C) resolve in one
  pass.
- Merge a target that is a cold rename stub, then move each row to its final
  name.
- Insert a stub for a vacated name **unless another row in the same batch is
  moving into it**. A swap therefore creates no stub; a chain stubs only its
  head.

The single-rename `applyItemRename` is a one-element wrapper over the batch.

### 2. Merge the stub into the live row

The live row id is never replaced. Before the stub is deleted:

- `watchlist_items`: delete rows that would duplicate an existing
  `(watchlist_id, live_id)` pair, then repoint the rest.
- `item_topics`: copy links to the live row (`ON CONFLICT DO NOTHING`), delete
  the stub links and recompute `topics.item_count` for the touched topics.
- `alerts` and `alert_events`: repoint `item_id`.
- `item_aliases`: rewrite both directions to the live id, drop self-links and
  duplicate `(item_id, alias_item_id, relation)` triples, then delete the
  stub's rows.
- Delete the stub only if it still has the `stub` flag; the final move would
  otherwise collide on the unique name.

Snapshots, scores, daily metrics and the row's tier are untouched because they
already belong to the live id.

### 3. De-duplicate the chunk by natural key

`persistNormalizedItems` collapses entries with the same
`(source, external_id)` before opening the transaction. The first occurrence
wins; duplicates are logged at debug level. Both the upsert and the snapshot
arrays therefore contain one row per natural key, which also removes the
"cannot affect row a second time" failure mode inside a single statement.

### 4. Isolate a failed chunk per item

If the chunk transaction fails, each de-duplicated item is retried in its own
transaction so a single poison item cannot discard the rest. The function
returns `{ upserted, failed }`; the ingest processor adds both to its run
recorder, so isolated failures make the run `partial`. More than half failing
(or ten failures in one chunk) rethrows from the persistence boundary so the
job-level retry engages.

Thresholds and scope:

- A one-item chunk rethrows immediately (there is nothing to isolate).
- After **10** isolated failures the loop rethrows the last error instead of
  paying for a systemic failure (database down) item by item.
- If more than half of the retried items fail, the last error is rethrown after
  the successful items have committed. They stay committed (the writes are
  idempotent) and the job retry re-attempts the whole set.

Per-item isolation is a recovery path, not the normal path: swaps that span a
failed chunk may be split across retries and fail on that attempt. They roll
back cleanly and resolve on the next cycle; no partial rename is committed.

## Consequences

- A rename-back preserves the live row id and all history, and the payload that
  triggered the rename upserts onto the live row instead of the stub.
- A swap/chain no longer depends on iteration order.
- Stub merge touches user-visible engagement; tests cover deduplication of
  watchlist rows and both alias directions.
- A poison item is reported as `failed` and the run can finish `partial`; it no
  longer forces every other snapshot in the chunk to be re-fetched.
- The temporary external ids exist only inside the transaction. A crash rolls
  them back; no cleanup job is needed.

## Tests

- `packages/db/test/int/renames.int.test.ts`: rename-back merges watchlists
  (including a duplicate), topics, alerts, alert events and both alias
  directions, then replays the triggering upsert against the live id; a
  two-item swap and an A→B→C chain stage names correctly and create no
  intermediate stubs.
- `apps/worker/test/int/upsert-isolation.int.test.ts`: duplicate natural keys
  collapse to one upsert; a negative daily value poisons one item while the
  other item's row and snapshot survive, and the returned failure count is 1.
