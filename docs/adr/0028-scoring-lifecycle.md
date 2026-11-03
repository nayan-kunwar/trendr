# ADR-0028 — Scoring lifecycle and cadence

- Status: Accepted (Phase 5)
- Date: 2026-11-03
- Spec: §8.4, §8.2, §7.1 (operational behaviour; no formula changes)
- Findings: M-3, L-5, L-8, L-9

## Context

`runScoring` owns a Redis lock per source (`lock:score:{source}`, `SET NX PX
120000`), writes one `ingestion_runs` row, scores every window, rebuilds the
combined board and publishes leaderboards. Four operational defects surround
that flow.

1. **M-3 — the lease is a deadline.** The TTL was 120 s and nothing renewed it.
   A slow run (full board rebuild, cold cache, database pressure) could lose the
   lock while still writing, and a second worker would start a concurrent run
   for the same source. Separately, `swapCurrentRun` was an unconditional
   upsert: a late-finishing older run could replace a newer `score_runs_current`
   pointer, and the skipped-lock path returned success with no run row at all —
   indistinguishable from a real run in the queue result.
2. **L-5 — bookkeeping masks the real error.** In the failure path a throwing
   `finishRun` replaced the original job error, and `RunRecorder.finish` marked
   itself done *before* awaiting, so the run row could stay `running` with no
   second attempt.
3. **L-8 — scoring follows every job, not the batch.** Each ingest job enqueued
   `compute-scores` immediately, so a multi-tier fan-out could score halfway
   through its own batch and publish a partial board. Admin item edits changed
   tier/flags but did not invalidate the leaderboard caches.
4. **L-9 — the all-board rebuild loads everything.** `rebuildAllBoard` selected
   every current score row for a window into memory before ranking, although
   only `topN` placements can ever be written.

## Decision

### 1. A renewable lease (M-3)

`LOCK_TTL_MS` stays 120 s; a timer renews it every 30 s with a Lua
compare-and-pexpire, so only the owner extends it. The timer is `unref`'d and
cleared before the release script runs. `LOCK_RENEW_MS` is not configurable at
runtime — the halves give four renewal attempts per TTL.

`swapCurrentRun` now performs a conditional upsert:

```sql
ON CONFLICT (source, window) DO UPDATE
SET run_id = excluded.run_id, computed_at = excluded.computed_at
WHERE (score_runs_current.computed_at, score_runs_current.run_id)
    < (excluded.computed_at, excluded.run_id)
```

and returns whether the pointer moved. Scores from a late run are still
inserted (they are valid data and retention prunes them); they simply never
become current. Because `computed_at` is floored to the hour, the run id is the
tie-breaker, and run ids are identity-increasing.

`runScoring` returns a discriminated outcome — `{status:'scored', runId, …}` or
`{status:'skipped', reason:'lock-held'}` — and the scoring job returns
`{source, windows, status, runId?}`. A new counter
`trendr_scoring_runs_total{source,outcome}` makes skips visible.

### 2. Bookkeeping never replaces the job error (L-5)

`RunRecorder.finish` sets its `finished` flag only after `finishRun` resolves,
so a failed close can be retried. `failRun` logs a bookkeeping failure with the
original error and retries once, then lets the original error propagate.
`runScoring` uses the same pattern for its failed-run update.

### 3. Batch-window cadence (L-8)

Ingest-triggered scoring is enqueued with a delay to the next ten-minute
scoring slot (`scoringSlot`) instead of immediately. The deterministic job id
already dedupes runs requested inside one slot, so a whole fan-out produces one
job that executes at the slot boundary, after the batch window. Admin and
scheduled triggers stay immediate.

Ingest completions pass `slot: scoringSlot(now)` and
`delayMs = delayToNextScoringSlot(now)`; admin and scheduled triggers pass
neither. The slot is ten minutes (`SCORING_SLOT_MS`).

Admin item patches invalidate `item:{id}`, every `card:{id}:{window}`, and
`lbmeta:{source}:{window}` plus `lbmeta:all:{window}`. A missing `lbmeta` makes
the leaderboard route fall back to SQL (fresh item state, new ETag) instead of
serving a stale Redis board; the next scoring run republishes the metadata.

### 4. Bounded all-board load (L-9)

`rebuildAllBoard` selects at most `max(1, floor(maxShare × topN))` rows per
source, ordered by the same keys `buildAllBoard` sorts on
(`z_score DESC, percentile DESC, final_score DESC, item_id`). Rows beyond a
source's cap can never place, so the board is identical while memory is bounded
by `sources × cap` instead of the full score table.

## Consequences

- A long run keeps exclusive ownership of its source; a second worker still
  skips, and the skip is now observable.
- A late run cannot rewind `score_runs_current`, so readers never alternate
  between two runs.
- A run whose bookkeeping fails is still retried by BullMQ, and the operator
  sees the original failure reason.
- Boards change at slot boundaries rather than mid-batch. The maximum added
  latency is one ten-minute slot.
- The combined board reads `sources × perSourceCap` rows instead of every
  current score row.

## Verification

- `apps/worker/test/unit/scoring-lock.test.ts`: renewal cadence, compare-and-
  pexpire arguments, stop behaviour, logged renewal failure.
- `apps/worker/test/int/run-scoring.int.test.ts`: lock-held runs return
  `skipped` and increment the counter; `swapCurrentRun` refuses older and
  equal-timestamp-lower-id swaps.
- `apps/worker/test/int/scoring-queue.int.test.ts`: the job result carries
  `status: 'scored'` and the run id.
- `apps/worker/test/unit/scoring-schedule.test.ts` and the ingest processor
  integration test: the delay is inside one slot and the enqueued scoring job
  carries it.
- `apps/api/test/int/admin.int.test.ts`: a patch clears the item, card and
  board-metadata keys.
- `apps/worker/test/int/run-scoring.int.test.ts`: the bounded candidate load
  never exceeds `sources × cap`, and the persisted `rank_all` board equals a
  full in-memory `buildAllBoard` rebuild.
- `apps/worker/test/unit/run-recorder.test.ts`: a failed close stays retryable, `failRun` retries once, logs the original error and never throws.
