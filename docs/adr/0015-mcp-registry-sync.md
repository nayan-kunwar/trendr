# 0015 — MCP registry synchronization and derived snapshots

- Status: Accepted
- Date: 2026-10-20
- Phase: 5 (5.5)
- Source: TRENDR_SPEC.md §7.2, §7.3.6, §18 task 5.5

## Context

The MCP registry is still in preview and exposes the same list endpoint under `/v0.1` and `/v0`.
Both return 200 on 2026-10-20, but the spec asks for `v0.1` with a fallback to `v0` on 404. The
registry has no documented page or inventory limit. Acceptance enumerated **48,379 latest
servers in 484 pages** on 2026-10-20 — a fixed 100-page cap would silently stop synchronizing.
Deleted entries are only returned when `include_deleted=true`; `updated_since` forces that flag.

The registry also has no popularity data. MCP item metrics must be derived from linked GitHub,
npm, and PyPI alias targets, but newly discovered items start in the `warm` tier while §7.2 lists
only an hourly **hot** snapshot. Without a warm snapshot, registry items would never receive
derived metrics and could never enter scoring.

## Decision

1. **Registry version.** List calls target `/v0.1`; only the first page's 404 triggers a retry
   against `/v0`, after which the chosen base is used for the rest of the walk. Server detail URLs
   use `/v0.1/servers/{encoded-name}/versions/latest`.
2. **Cursor.** Incremental discovery calls `updated_since=<max updatedAt>` and stores the maximum
   observed `updatedAt` in `mcp:registry:cursor_ts` only after a **complete** page walk. A truncated
   pass leaves the cursor untouched. The weekly full pass ignores the cursor and advances it only
   after reaching the last page. `version=latest` and `include_deleted=true` are always sent.
3. **Full-scan bound.** The defensive bound is **50,000 items / 500 pages**. At the 2 req/s bucket
   this is roughly four minutes for an empty cursor; it protects against a runaway cursor rather
   than normal inventory. The previous 10,000/100 bound was rejected after live discovery reached
   it with more registry pages still remaining. The live inventory is 48,379 in 484 pages, so the
   bound currently has ~1,600 items / 16 pages of headroom; if registry growth consumes that, raise
   the bound before the next weekly full pass rather than weakening the cursor rule.
4. **Schedules.** `mcp-discover` (`0 */2 * * *`, incremental) and `mcp-discover-full`
   (`30 0 * * 0`, full) are separate rows because §7.2 names both. The GitHub/npm fallback runs
   every six hours (`50 */6 * * *`).
5. **Warm snapshots.** Add `mcp-snapshot-warm` (`35 */6 * * *`) next to the spec's hourly hot row.
   Both use the generic `snapshot-fanout`; no registry call is made. Alias target stubs are inserted
   warm, and existing target rows in `cold`/`archived` are promoted to warm so their source adapters
   snapshot them.
6. **Deletes.** Registry `status=deleted` sets `items.is_deleted=true` monotonically; later active
   payloads do not resurrect the row. Deleted alias targets are skipped by derived queries.
7. **Multiple aliases / mixed schemas.** If a server lists more than one package (or more than one
   GitHub alias), the target with the largest latest value supplies the derived metric; the MCP item
   keeps a single stars/downloads series rather than summing unrelated packages. The live registry
   emits older `$schema` values (`2025-09-29`) alongside the pinned `2025-12-11`; the adapter logs
   the first mismatch per pass and continues with the defensive schema.

## Consequences

- Incremental runs are cheap and replay-safe; a failed or truncated pass never loses the watermark.
- The weekly full pass is bounded but large enough for the observed registry. If the registry grows
  past 50k servers, the bound (not the cursor logic) must be revisited.
- MCP items can accumulate their own derived stars/download history before they become hot, so the
  source is visible in scoring without manual promotion.
- Alias stubs are real warm items and may cause their source adapters to snapshot repositories and
  packages that were not previously tracked. That is intentional: it is the only way to obtain the
  registry item's derived metrics.
