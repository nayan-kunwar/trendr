# 0016 — Additive item-topic persistence during ingestion

- Status: Accepted
- Date: 2026-10-21
- Phase: 5 (5.6)
- Source: TRENDR_SPEC.md §7.1 step 5, §18 task 5.6

## Context

Spec §7.1 step 5 requires every ingestion chunk to upsert `items`, `item_topics`, snapshots,
daily metrics and aliases in one transaction. Earlier adapter tasks normalized topic slugs into
`NormalizedItem.item.topics`, but the worker deferred writing `topics`/`item_topics`; this was the
last shared persistence gap in the ingestion pipeline.

The spec caps each item at 20 topics but does not state what happens when a later upstream payload
contains a different, smaller topic set. Discovery payloads are often incomplete (npm search omits
keywords, an HF list page may not carry the same tags as the detail page), so treating omissions as
deletions would silently lose useful classification data. `topics.item_count` is also a
denormalized column used by topic-filtered queries and must stay consistent with the link table.

## Decision

1. **Normalize at the persistence boundary.** `persistTopics` runs the core
   `normalizeTopicSlugs` helper even though adapters already normalize. This guarantees the
   database CHECK/cap invariants for every source and any future adapter that forgets to normalize.
2. **Links are additive.** A payload inserts missing `item_topics` rows but never deletes links
   that are absent from the current payload. Existing links are ignored via the composite primary
   key. Explicit topic removal is not part of the ingestion contract.
3. **Insert topics idempotently.** New `topics` rows get a titleized display name derived from the
   slug; existing rows are left untouched. `onConflictDoNothing` makes chunk retries safe.
4. **Refresh only touched counters.** For the topics linked by this chunk, recompute
   `topics.item_count` from `item_topics` after the inserts. This keeps the denormalized count
   correct without scanning or updating every topic in the database.
5. **One transaction.** Topic links are written in the same transaction as items, aliases,
   snapshots and daily metrics, so a failed chunk cannot leave a partially linked item.

## Consequences

- Re-running discovery is idempotent, and a source that stops reporting a keyword keeps its prior
  topic link. This favors recall over exact mirroring of the latest payload.
- If an explicit topic cleanup is ever required, it needs a separate reconciliation job that
  deletes links before recomputing counts; ingestion will not infer deletions.
- Topic-filtered queries can rely on `item_count` after each successful chunk. Counts for items
  deleted by other paths are not automatically refreshed here, matching the existing seed behavior.
