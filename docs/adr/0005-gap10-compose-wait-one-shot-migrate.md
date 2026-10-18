# 0005 — GAP-10: `docker compose up --wait` with the one-shot `migrate` service

- Status: Accepted (verified on Compose v5.4.0)
- Date: 2026-10-18
- Phase: 0 (0.7–0.8)
- Source: TRENDR_SPEC.md §17.1, §17.4 note; GAP-10

## Context

The compose file runs migrations as a one-shot `migrate` service (`restart: "no"`) and gates `api`
and `worker` on `service_completed_successfully`. §17.4 warns that behaviour differs across Compose
releases: some may treat the exited container as a failure under `docker compose up --wait`.

## Decision

Verified on **Docker Compose v5.4.0** (Docker Desktop 29.7.2):

```text
docker compose up -d --wait --wait-timeout 600 postgres redis migrate api worker web mcp
→ migrate: Exited (0); api/worker/postgres/redis healthy; web and mcp running; exit code 0
```

`--wait` accepts the exited one-shot container as satisfied and proceeds to the health-gated
services. Keep the spec's plain `--wait` in local flows and CI.

Documented fallback (spec §17.4 note) if a Compose release ever disagrees: run
`docker compose run --rm migrate` first, then `docker compose up -d --wait` for the long-running
services. The CI compose-smoke job carries a comment pointing here.

## Consequences

- No divergence from the spec's compose file; CI smoke uses a single `up` command.
- Re-verify when the pinned Compose major version changes.
