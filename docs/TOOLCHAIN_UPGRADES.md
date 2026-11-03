# Toolchain upgrade ledger

**Last updated:** 2026-11-03  
**Current toolchain:** Node 22.20.0 · pnpm 11.7.0 · TypeScript 5.9.3 · ESLint 9.39.5 · Vitest 3.2.7

Dependabot proposes the whole toolchain at once, and merging it that way has failed three
cycles in a row: the failures come from several packages at different maturity levels, and
a single red job gives no attributable cause. This file records which upgrades are blocked
upstream, which are independent, and the order to take them in.

## Policy

`.github/dependabot.yml` groups minor and patch updates and leaves **development** majors
ungrouped, one PR each. Production majors stay grouped because they are rare and are
reviewed as one migration (ioredis 6 + Next 16 shipped together as `856876d`). When a
grouped development-major PR appears, close it and point at this file.

A wave is complete when, on its branch:

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:int` pass locally, and
- the PR's `lint-typecheck-unit`, `integration` and `compose-smoke` jobs are green.

## Waves

| Wave | Packages | Node floor | Status |
| --- | --- | --- | --- |
| A | `eslint` 10, `@eslint/js` 10, `globals` 17 | 22.13 | Planned |
| B | `vitest` 5, `@vitest/coverage-v8` 5 | 22.12 | Planned |
| C | `tsup` 9 | 22.18 | Planned |
| D | `@commitlint/cli` 21, `@commitlint/config-conventional` 21, `lint-staged` 17 | 22.22.1 | Planned |
| E | `undici` 8, `@types/nodemailer` 8 | 22.19 | Planned |
| F | `typescript` 7 | — | **Blocked upstream** |

`@types/node` majors are ignored in the Dependabot config: the runtime is Node 22, and a
newer `@types/node` would let the code compile against APIs that do not exist there.

## Blocked: TypeScript 7

`typescript-eslint@8.72.1` declares `typescript: >=4.8.4 <6.1.0` and refuses to run under
TS 7. The failure from the closed group PR (#21) is:

```
typescript-eslint does not support TS 7.0.
Please see https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/#running-side-by-side-with-typescript-6.0
to run typescript-eslint using the TS 6 API.
See also https://github.com/typescript-eslint/typescript-eslint/issues/10940 for tracking
typescript-eslint's support for TS >=7.1
```

Every workspace package runs `pnpm lint`, so a TS 7 bump fails `lint-typecheck-unit` before
typecheck starts, regardless of which other packages are in the same PR. TypeScript 7 waits
for typescript-eslint#10940. A TS 6.0 step is not required by anything here and is not
proposed by Dependabot yet.

## Wave notes

**A — ESLint 10.** `eslint@10.14.0` and `@eslint/js@10.0.1` need
`^20.19.0 || ^22.13.0 || >=24`; `typescript-eslint@8.72.1` peers `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0`,
so the combination is supported. The repo uses flat config (`eslint.config.js`) and does not
use the removed eslintrc path, the `--ext` flag or the removed `context` scope APIs.
`globals@17` only removes outdated global sets.

**B — Vitest 5.** Needs `^22.12.0 || ^24.0.0 || >=26.0.0`; peers `vite: ^6.4.0 || ^7.0.0 || ^8.0.0`,
and the lockfile already resolves vite 7.3.7 through the coverage tooling. The root Vitest
workspace config is unchanged by the major.

**C — tsup 9.** Needs `^22.18.0 || ^24.11.0 || >=26.0.0`. Every library and app builds through
tsup, so this wave is validated by the normal build path; the declaration build is the slow
part of CI but already runs on every job.

**D — commitlint 21 and lint-staged 17.** commitlint needs Node >= 22.12.0; lint-staged 17
needs **>= 22.22.1**, which is above the current local Node 22.20.0. Update the local runtime
before this wave, otherwise the pre-commit hook runs outside its supported engine range even
though CI (which installs the latest 22.x) is fine.

**E — undici 8 and @types/nodemailer 8.** undici needs Node >= 22.19.0 and is test-only
(`MockAgent` in the adapter tests), so a runtime mismatch would show up as a test failure, not
a production one. `@types/nodemailer@8` matches the nodemailer 10 already on `main`.
