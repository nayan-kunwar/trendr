# 0012 — Stargazer backfill reads weekly history buckets; the user listing is retired (GAP-7)

- Status: Verified (live capture 2026-10-19; GitHub restricted the listing endpoint with the June 2026 changelog)
- Date: 2026-10-19
- Phase: 4 (4.3)
- Source: TRENDR_SPEC.md §7.3.1; GAP-7

## Context

Spec §7.3.1 reconstructs star history from `GET /repos/{owner}/{repo}/stargazers`
with `Accept: application/vnd.github.star+json` (each row carries `starred_at`),
walking backwards from the last page; GAP-7 left the pagination-depth cap open
for very large repos.

The live recording (2026-10-19) showed that endpoint **no longer serves
non-collaborators**: `GET /repos/sindresorhus/got/stargazers` answered
`403 Resource not accessible by personal access token`, and unauthenticated
requests are rejected with `401`. GitHub's June 30, 2026 changelog ("Upcoming
access restrictions to public API endpoints and UI views") limits the listing
endpoints — stargazers, watchers, subscriptions — to **admins and
collaborators**. The old design cannot work for discovered public repos, so
GAP-7 turned out not to be a cap question: the endpoint was retired for this
use.

GitHub shipped replacements that do not expose the user list:

- `GET /repos/{o}/{r}/stargazers/count` → `{ "count": N }` (current total).
- `GET /repos/{o}/{r}/stargazers/history` → weekly buckets, newest first, each
  `{ week, total, days[7] }` with `week` = Sunday 00:00 UTC epoch-seconds and
  `days` = stars created that day (Sunday first, zero-filled). The docs caveat
  that week/day boundaries "are not guaranteed to align with UTC"; live
  captures show Sunday UTC weeks.

Both were verified live the same day and recorded as fixtures
(`stargazers-history.json`, `stargazers-count.json`; the listing's refusal is
kept as `stargazers-listing.json`).

## Decision

- `backfill` reads `stargazers/count` once (total now; `0` short-circuits to an
  empty series), then pages `stargazers/history?per_page=30&page=N` from page 1
  until the oldest fetched week starts at or before `now − days`, the pages run
  out (`[]`), or `BACKFILL_GITHUB_MAX_PAGES` stops it. GitHub caps `page` at 100
  (`422 Pagination is limited to 100 pages`), so the reachable depth is
  100 × 30 weeks ≈ 57 years — the GAP-7 depth concern is gone.
- A 35-day backfill costs **two** requests (count + one history page) regardless
  of repo size; the largest allowed window (365 days, spec §7.1) costs three.
- Output semantics are unchanged: end-of-day cumulative `stars` rows for
  `daily_metrics`, emitted only for days fully covered by the fetched pages —
  from `max(startOfDay(cutoff), coverage start)` through yesterday ("honest
  truncation": a shorter series, never a silently wrong value) — with
  `value(day) = totalStars − stars created after that day`. Because the count
  and the newest partial day come from the same run, yesterday's value is exact.
- The `Accept: application/vnd.github.star+json` header is gone; the retired
  listing is never called (its 403 is fixture evidence, not something the
  adapter exercises). `stargazers/history` and `stargazers/count` ride the same
  per-token core bucket (`rl:github:core:{tokenIdx}`) as every other REST call.
- The pure day maths live in `packages/sources/src/github/stars.ts`; the adapter
  owns HTTP. Unit tests pin the paging stop conditions, the page cap, the
  empty-repo short-circuit and the truncation (`github.adapter.test.ts`).

## Consequences

- Backfill became *cheaper and deeper*: requests no longer scale with star
  count, and even giant repos reach decades of history. The old
  "50 pages ≈ 5,000 stars" cap only remains as a budget guard for pathological
  windows.
- Daily counts come from weekly buckets split per day; the documented
  UTC-boundary caveat can shift a handful of stars across day boundaries, which
  the smoothed §8.2 growth windows tolerate.
- The spec's §7.3.1 backfill paragraph (listing walk with `star+json`) and the
  §18 task 4.3 acceptance line naming that header are superseded by this ADR;
  `docs/SPEC_REVIEW.md` records the deviation.
