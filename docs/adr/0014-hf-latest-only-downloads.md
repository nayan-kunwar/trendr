# 0014 — Hugging Face rolling downloads and discovery scheduling

- Status: Accepted
- Date: 2026-10-20
- Phase: 5
- Source: TRENDR_SPEC.md §7.2, §7.3.4, §18 task 5.3, GAP-5

## Context

The Hub exposes two download numbers for models and datasets:

- `downloadsAllTime` — the cumulative counter, comparable to GitHub stars.
- `downloads` — a **rolling ~30-day** count. Live on 2026-10-20,
  `google-bert/bert-base-uncased` returned `downloads=30,160,565` while
  `downloadsAllTime=3,267,215,234`; `fka/prompts.chat` returned `27,814` vs `723,968`.

Spec §7.3.4 correctly says the rolling value belongs only in `latest_metrics`; writing it into the
snapshot series would make the series fall whenever old downloads aged out and would make
`downloads_total` non-monotonic. The §5.1 `NormalizedItem` contract had no latest-only channel, and
`ItemUpsert` deliberately never touched `latest_metrics`.

The §7.3.4 discovery design has three model phases (top 500 trending, top 200 newest with `likes ≥ 5`,
and a daily top 1,000 by likes), but §7.2 defines only one `hf-discover` row (`0 * * * *`), with no
separate daily-likes row.

## Decision

1. Add an **optional additive field** `NormalizedItem.latestMetrics` (and the matching
   `ItemUpsert.latestMetrics`). It is persisted into `items.latest_metrics` by `upsertItems` using a
   JSONB merge (`items.latest_metrics || excluded.latest_metrics`); a row without the field keeps
   the existing values. It is never written to `snapshots`.
2. HF maps `downloadsAllTime` → the `downloads_total` snapshot and `downloads` → `latestMetrics`.
   Spaces have neither metric. `likes` and `trendingScore` remain ordinary snapshots. Because
   §5.2 stores `snapshots.value` as `bigint`, the occasionally fractional `trendingScore` is rounded
   to the nearest integer; the raw rolling `downloads` stays exact in `latest_metrics`.
3. The hourly `hf-discover` uses the `trending` strategy: five 100-item trending pages plus two
   100-item newest pages (`likes ≥ 5`), 700 model items. The job cap is
   `HUGGINGFACE_DISCOVERY_MAX_ITEMS` (1,100) so the optional two-page dataset and space phases fit
   when their flags are enabled. The adapter also implements `strategy=likes` (ten pages, 1,000
   items), but §7.2 has no row for it. It is available through the manual discover job and is
   **not scheduled**; adding a row is deferred until the spec table is amended.
4. The three §7.2 snapshot rows use the generic `snapshot-fanout` job (like GitHub) rather than a
   single direct `snapshot` job. This is what gives the detail fallback the documented concurrency
   of 4; the fan-out child payload is unchanged.
5. Anonymous Hub requests are capped at the observed `500/5 min` budget even when
   `HF_RATE_PER_5MIN` is left at its authenticated default of 1,000. The adapter parses
   `RateLimit: "api";r=…;t=…` on 429 and pauses the shared `huggingface:api` bucket for `t`
   seconds.

## Consequences

- HF gets a current rolling-download figure in `latest_metrics` without polluting trend series.
- The DB merge is safe for every other adapter: they omit `latestMetrics`, so their existing value
  is preserved.
- The daily likes sweep is not automatic. Manual `strategy=likes` works and is tested; a future
  scheduler row can be added without an adapter change.
- Fan-out means the spec table's “snapshot hot/warm/cold” semantics are implemented through the
  existing `snapshot-fanout` name; the tier, cron and source are exactly the §7.2 values.
