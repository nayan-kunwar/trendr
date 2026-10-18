# 0009 — Reproducible container builds on flaky container networks

- Status: Accepted
- Date: 2026-10-18
- Phase: 0 (0.7)
- Source: TRENDR_SPEC.md §17.2 (Dockerfiles)

## Context

Building the four node images surfaced a chain of container-networking and tooling failures:
Corepack resolving `pnpm latest` over the network, `pnpm add -g turbo` failing because global bins
were not on `PATH`, registry `ETIMEDOUT`/NAT64 `ENETUNREACH` waves amplified by four parallel image
builds, and `turbo prune` output missing root files that packages `extends` (`TS5083` cascade).

## Decision

`infra/docker/node.Dockerfile` and `web.Dockerfile`:

- **Pin the toolchain**: `ARG PNPM_VERSION=11.7.0` + `corepack install --global pnpm@${PNPM_VERSION}`
  (no "latest" resolution at build time); `PNPM_HOME`/`PATH` exported so global bins resolve.
- **IPv4-first DNS** in builds: `ENV NODE_OPTIONS=--dns-result-order=ipv4first`.
- **Throttled installs**: `pnpm install --frozen-lockfile --prefer-offline --network-concurrency 6
  --fetch-retries 5`, with a shared buildkit cache mount for the pnpm store (`id=pnpm`).
- **Sequential image builds locally**: `docker compose build api && … web` so installs reuse the
  warm store instead of hammering the registry in parallel (`up --build` on a healthy network is
  fine and is what CI uses).
- **Copy `tsconfig.base.json` from the pruner stage** explicitly — `turbo prune` ships workspace
  packages but not root config files that packages `extends`.
- **Web image**: standalone output is opt-in via `NEXT_STANDALONE=true` (set only in the
  Dockerfile) with `outputFileTracingRoot` set to the repo root in the monorepo.

## Consequences

- First build is slower, later builds deterministic; the store cache accumulates across builds.
- The throttles/`NODE_OPTIONS` are environment hardening and can be revisited if container
  networking improves; the corepack pin and the `tsconfig.base.json` copy must stay regardless.
- The spec's Dockerfile lines are otherwise unchanged (see SPEC_REVIEW R-1/R-3 for the two fixes).
