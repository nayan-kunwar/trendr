# 0006 — GAP-11: `pnpm deploy --prod --legacy` and the migrate path

- Status: Accepted
- Date: 2026-10-18
- Phase: 0 (0.7)
- Source: TRENDR_SPEC.md §17.2, GAP-11

## Context

Runtime images are built by deploying the target workspace package to `/out`:

```text
pnpm --filter=@trendr/${APP} deploy --prod --legacy /out
```

pnpm 10+ introduced a new deploy implementation that requires `inject-workspace-packages=true`
unless `--legacy` is passed; §17.2 uses `--legacy`.

## Decision and evidence

**pnpm 11.7.0 still supports `--legacy`.** The legacy deploy produces a self-contained `/out`, but
its top-level `node_modules` holds only *direct* dependencies; transitive ones (e.g. `pg` for
`@trendr/db`) live under `node_modules/.pnpm/<pkg>/node_modules/`.

Consequently the spec's loose copy of `packages/db/dist/migrate.js` could not resolve `pg`
(`ERR_MODULE_NOT_FOUND`), because that path sits outside any `node_modules` resolution chain.

Fix in `infra/docker/node.Dockerfile` — symlink the deployed package into the path §17.1's compose
command already expects:

```dockerfile
RUN mkdir -p /out/packages && ln -sfn ../node_modules/@trendr/db /out/packages/db
```

`node packages/db/dist/migrate.js` then resolves through the `.pnpm` realpath, where `pg` is a
sibling of `@trendr/db`. `docker-compose.yml` stays verbatim.

## Consequences

- The `migrate` service works from the deployed image; `worker`/`mcp` images carry the symlink
  harmlessly (dangling where `@trendr/db` is not a dependency).
- Expected build warning: "Shared workspace lockfile detected but configuration forces legacy
  deploy implementation."
- Re-check both the flag and the layout on any pnpm major upgrade.
