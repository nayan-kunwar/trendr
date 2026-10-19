# 0011 — GitHub GraphQL batch point cost is measured, not assumed (GAP-1)

- Status: Verified (measured live 2026-10-19 — 1 point at 3 and 50 aliases, and for the production snapshot batch)
- Date: 2026-10-19
- Phase: 4 (4.3)
- Source: TRENDR_SPEC.md §7.3.1; GAP-1

## Context

Spec §7.3.1 snapshots GitHub repos through one GraphQL query with up to 50
`repository(owner:, name:)` aliases. GitHub's GraphQL budget is point-based and
the spec's GAP table records the open question: the point cost of a 50-alias
`repository` query is *expected* ≈ 1, to be measured via `rateLimit { cost }`.
Throttling maths that assumes the wrong cost either starves the source or burns
the hourly budget silently.

## Decision

- Every batch query selects `rateLimit { cost remaining resetAt }`
  (`buildBatchQuery` appends it unconditionally); `parseBatchResponse` surfaces
  the measured cost with the results.
- The adapter logs the measured cost per batch at debug (GAP-1 evidence) and
  passes `remaining`/`resetAt` through `AdapterContext.onRateLimit` → the
  `trendr_rate_limit_remaining{source,resource}` gauge and the run row. A
  `remaining` below `GITHUB_RESERVE` (default 200) pauses the requesting
  token's bucket until `x-ratelimit-reset` (§7.4).
- `record.ts` (`RECORD=1 pnpm fixtures:record --source github`) replays the same
  query at 3 and 50 aliases against the live API and writes the observed costs
  (plus the depth/expiry probes for GAP-7/8) into `__fixtures__/meta.json`.
- No throttling step charges more than the bucket's configured unit cost until a
  live measurement says otherwise; the spike is confined to `parseBatchResponse`
  and the debug log.
- Live measurement (2026-10-19, `RECORD=1 pnpm fixtures:record --source github`,
  `__fixtures__/meta.json`): **1 point at 3 aliases, 1 point at 50 aliases**, and
  1 point for the production `buildBatchQuery` snapshot batch — the ≈ 1
  assumption holds, so no throttling constant changes were needed.

## Consequences

- One extra root field per batch — negligible response growth, and the cost is
  visible per run without a separate probe call.
- The live run confirmed the documented ≈ 1 cost at both batch sizes, so the
  bucket debit and reserve maths stay as implemented. If GitHub ever changes
  the cost, `meta.json` and the `trendr_rate_limit_remaining` gauge surface it
  on the next recording without a code change.
