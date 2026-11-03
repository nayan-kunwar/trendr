# ADR-0025 — Index-backed trigram search fallback

- Status: Accepted (Phase 4)
- Date: 2026-11-03
- Spec: §7.5, §10.1 (behaviour preserved; physical plan changed)
- Finding: M-1

## Context

`/v1/search` runs full-text search first and appends a trigram tail when the FTS
result has fewer than five hits. The fallback used:

```sql
word_similarity(lower($q), lower(display_name)) > 0
```

Two problems:

1. The only trigram index was `items_name_trgm_idx` on raw `display_name`
   (spec §5.2). The query compares `lower(display_name)`, so the expression
   does not match the index.
2. `word_similarity(text, text)` is a scalar function call. Postgres has no
   planner rule that turns it into an index scan; only the `%`, `%>`, `<%`
   operators and `LIKE`/regex forms are indexable. An EXPLAIN of the exact
   predicate against a functional GIN index — with `enable_seqscan = off` —
   still returns `Seq Scan` (measured locally on PG16 and PG18).

So adding the functional index alone would not have changed the plan. The
review's remediation ("functional GIN index, confirm with EXPLAIN") needed one
more step to be true.

## Decision

1. **Functional index.** `items_display_name_trgm_idx` is a GIN index on
   `lower(display_name)` with `gin_trgm_ops`. `items_name_trgm_idx` on raw
   `display_name` stays: the spec lists it, and it serves case-sensitive
   prefix/LIKE lookups.
2. **Indexable predicate.** The fallback predicates with
   `lower(display_name) %> lower($q)`. The column is on the left because that is
   the indexed expression the operator can use.
3. **Transaction-scoped threshold.** pg_trgm's defaults (`%` 0.3,
   `word_similarity_threshold` 0.6) drop the spec's own `nxt` →
   `vercel/next.js` pair (word similarity ≈ 0.286). The fallback runs inside
   `db.transaction()` and calls
   `set_config('pg_trgm.word_similarity_threshold', '0.150', true)`, so the GUC
   is local to that transaction and pooled connections keep the default.
4. **Ranking is unchanged.** Results are still ordered by the exact
   `word_similarity(lower(q), lower(display_name))` the API reports, then id
   desc, and the keyset cursor still compares `(similarity, id)`.

## Consequences

- The candidate set is bounded by the trigram index instead of the whole `items`
  table. `EXPLAIN` with `enable_seqscan = off` selects
  `items_display_name_trgm_idx`.
- The result set changes at the fringe: a row that shares a boundary trigram but
  scores below 0.15 no longer appears. That is the intended noise reduction —
  the previous `> 0` floor let any same-first-letter word match.
- The fallback costs two extra round trips (`BEGIN`/`set_config`/`COMMIT`). It
  only runs when FTS returned fewer than five hits.
- Two trigram GIN indexes are maintained on `items`. Fastupdate amortises the
  write cost; `items_name_trgm_idx` is currently unused by queries and can be
  dropped later if write amplification becomes measurable.

## Verification

- `packages/db/test/int/search-index.int.test.ts`: index definition; the
  planner selects the index for the fallback predicate; the `nxt` pair resolves;
  the GUC is back to `0.6` outside the transaction.
- `apps/api/test/int/search.int.test.ts` (all 15 cases, including the §18
  acceptance pair and two-part cursor pagination) still passes.
