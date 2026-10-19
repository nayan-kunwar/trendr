/**
 * Spec §7.3.1 / ADR 0012 — star-history reconstruction for the GitHub backfill.
 *
 * The original design walked `GET /repos/{o}/{r}/stargazers` with
 * `Accept: application/vnd.github.star+json`, newest page backwards. GitHub
 * retired that listing for anyone but admins and collaborators (June 2026), so
 * the adapter now reads `GET /repos/{o}/{r}/stargazers/history` — weekly
 * buckets whose `days` array holds the stars created on each UTC day, Sunday
 * first — plus `GET /repos/{o}/{r}/stargazers/count` for the current total.
 *
 * This module is pure (the adapter owns HTTP): fixtures pin the week → day
 * mapping and the truncation semantics.
 */
const DAY_MS = 86_400_000;

/** GitHub's documented maximums for `stargazers/history`. */
export const STARGAZER_HISTORY_PAGE_SIZE = 30;
export const STARGAZER_HISTORY_MAX_PAGE = 100;

/** The structural subset of a history row the maths needs. */
export interface StargazerHistoryWeek {
  /** Unix seconds of the week's Sunday 00:00 UTC. */
  week: number;
  /** Stars created that week. */
  total: number;
  /** Stars created each day, Sunday first. */
  days: readonly number[];
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Expand weekly buckets into `'YYYY-MM-DD'` → stars created that (UTC) day. */
export function dailyStarCounts(weeks: readonly StargazerHistoryWeek[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const week of weeks) {
    for (let index = 0; index < 7; index += 1) {
      counts.set(isoDay((week.week + index * 86_400) * 1_000), week.days[index] ?? 0);
    }
  }
  return counts;
}

/**
 * Oldest day the fetched pages prove complete: the Sunday the last (oldest)
 * bucket starts on. Pages are contiguous, so every day from here through the
 * current week is covered.
 */
export function stargazerCoverageStart(weeks: readonly StargazerHistoryWeek[]): Date | null {
  const oldest = weeks.at(-1);
  return oldest === undefined ? null : new Date(oldest.week * 1_000);
}

/**
 * End-of-day cumulative star history (spec §7.3.1 backfill contract, ADR 0012).
 *
 * `counts` must cover every day from `coverageStart` through `now` (history
 * pages zero-fill empty weeks, so they are dense); `totalStars` is the
 * `stargazers/count` value read in the same run, which makes
 * `value(day) = totalStars − stars created after that day` exact even though
 * the current day is still partial. Only days at or after
 * `max(startOfDay(cutoff), startOfDay(coverageStart))` and up to yesterday are
 * emitted — honest truncation, never a silently wrong value.
 */
export function cumulativeStarHistory(
  counts: ReadonlyMap<string, number>,
  totalStars: number,
  cutoff: Date,
  now: Date,
  coverageStart: Date,
): { day: string; value: number }[] {
  if (totalStars <= 0) return [];
  const startOfDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;
  const firstDay = Math.max(startOfDay(cutoff.getTime()), startOfDay(coverageStart.getTime()));
  const lastDay = startOfDay(now.getTime()) - DAY_MS; // yesterday: the last complete day
  const rows: { day: string; value: number }[] = [];
  if (lastDay < firstDay) return rows;
  // Stars created after the day being emitted: start past yesterday with the
  // current (partial) day. Today's bucket and `totalStars` come from one run.
  let after = counts.get(isoDay(startOfDay(now.getTime()))) ?? 0;
  for (let day = lastDay; day >= firstDay; day -= DAY_MS) {
    rows.push({ day: isoDay(day), value: totalStars - after });
    after += counts.get(isoDay(day)) ?? 0;
  }
  rows.reverse();
  return rows;
}
