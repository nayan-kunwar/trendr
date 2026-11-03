# ADR-0027 — Release supply chain

- Status: Accepted (Phase 7)
- Date: 2026-11-03
- Spec: §17.1 (images), §17.4 (CI)
- Findings: M-9, L-3

## Context

`publish.yml` built and pushed four images on a tag or a manual run without
checking CI, with every action on a moving major tag (`@v4`, `@v3`) and no
vulnerability scan or signature. `docker-compose.prod.yml` fell back to
`:latest` when `TRENDR_TAG` was unset, so a host could silently run a different
build after a redeploy. The node runtime images were already non-root
(`USER node` + tini), but the compose services had no capability drop and the
base images were tag-pinned only.

## Decision

1. **CI gate.** `ci.yml` gains `workflow_call`; `publish.yml` starts with a
   `verify` job that calls it, and both publish jobs `needs: verify`. An image
   can only be built from a commit whose full matrix is green.
2. **Pinned actions.** Every `uses:` in both workflows is a full commit SHA
   with the version in a comment. Updating an action is a reviewable diff.
3. **Pinned base images.** `node:22-alpine`, `postgres:16-alpine`,
   `redis:7-alpine`, `nginx:1.27-alpine`, Prometheus, Grafana, Jaeger and
   Mailpit are referenced by tag **and** digest in the Dockerfiles/compose
   files.
4. **Signed, scanned, attested.** The publish build sets `sbom: true` and
   `provenance: true`, runs Trivy against the pushed digest and fails on
   HIGH/CRITICAL findings with a fix available, then signs the digest with
   keyless cosign (`id-token: write`).
5. **Explicit release tag.** `docker-compose.prod.yml` uses
   `${TRENDR_TAG:?set TRENDR_TAG}` for all four GHCR images. A deploy without
   it fails instead of running `latest`. The Render blueprint keeps `:latest`
   because Render pulls on deploy and the publish workflow only moves `latest`
   on semver tags.
6. **Runtime hardening.** API, worker, web, MCP and migrate drop all Linux
   capabilities and keep `no-new-privileges`; they already run as `node`.

## Consequences

- A release takes longer (the full CI matrix runs inside the publish workflow)
  and costs more Actions minutes. That is the point.
- A CVE in a base image now fails the next publish until the digest is bumped,
  which is a deliberate prompt rather than a surprise at runtime.
- `cosign verify` requires the workflow identity; the runbook documents the
  command and the keyless issuer/repository.
- The VPS deploy is reproducible from `TRENDR_TAG`; Render deploys remain
  "newest released image" by design.

## Verification

- `publish.yml`/`ci.yml` parse as YAML; `actions` are SHA-pinned (grep-audited).
- `docker compose build api` and `build web` succeed with the digest-pinned
  base images.
- `docker compose -f docker-compose.prod.yml config` fails without
  `TRENDR_TAG` and succeeds with it.
- The first tagged publish is the real end-to-end check for Trivy/cosign;
  that remains a release-time verification.
