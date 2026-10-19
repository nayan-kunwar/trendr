# 0012 — Stargazer backfill walks backwards with a page cap and honest truncation (GAP-7)

- Status: Provisional (cap chosen from the §7.4 budget; depth probe pending a live token)
- Date: 2026-10-19
- Phase: 4 (4.3)
- Source: TRENDR_SPEC.md §7.3.1; GAP-7

## Context

Star history is reconstructed from `GET /repos/{owner}/{repo}/stargazers` with
`Accept: application/vnd.github.star+json` (each row carries `starred_at`). A
popular repo has tens of thousands of stars — thousands of pages — while the
§7.4 rate-limit budget is shared with discovery and snapshots. The spec's GAP
table leaves the pagination depth cap open (GAP-7).

## Decision

- Walk **backwards from the last page** (`Link rel="last"`), so the most recent
  history — the part scoring and charts need — is always complete even when the
  walk stops early.
- Stop as soon as a page's `starred_at` predates `now − days` (the requested
  window): older pages cannot contribute to any requested day.
- Hard cap `BACKFILL_GITHUB_MAX_PAGES` (default 50 pages ≈ 5,000 stars) per
  backfill; the cap is enforced in the adapter and covered by a unit test with a
  pinned page sequence.
- `cumulativeStarHistory` is pure and **emits a day only when the walk proves it
  complete**: a day is written only if every star up to that day's end was seen.
  Otherwise the reconstructed cumulative count would understate the real value
  and feed wrong growth into scoring. Truncation therefore shows up as missing
  oldest days, never as silently wrong values.
- One `Accept: application/vnd.github.star+json` header per page is asserted in
  the request-shape tests (spec acceptance wording).

## Consequences

- Bounded spend per item: at most `BACKFILL_GITHUB_MAX_PAGES` requests, all
  riding the standard bucket with §7.4 reserve handling.
- Repos beyond the cap get a shorter series that simply starts later; raising
  the cap is one env change and the test fixture is parameterized.
- `record.ts` probes real depth (first/last page + total pages) and records it
  as GAP-7 evidence once a live token is available; until then the cap follows
  the budget rather than data, as documented here.
