# Toolchain upgrade ledger

**Last updated:** 2026-11-04  
**Current toolchain:** Node 22.20.0 · pnpm 11.7.0 · TypeScript 5.9.3 · ESLint 10.14.0 · Vitest 5.1.0 · tsup 9.0.0

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
| A | `eslint` 10, `@eslint/js` 10, `globals` 17 | 22.13 | Merged — `4b95b52` |
| B | `vitest` 5, `@vitest/coverage-v8` 5 | 22.12 | Merged — `e71767b` |
| C | `tsup` 9 | 22.18 | Merged — `e8c4097` |
| D | `@commitlint/cli` 21, `@commitlint/config-conventional` 21, `lint-staged` 17 | 22.22.1 | Merged — `b74925b` |
| E | `@types/nodemailer` 8 | — | Merged — `0919bc6` |
| E' | `undici` 8 | 22.19 | **Deferred** — see below |
| F | `typescript` 6 | — | **Deferred** — see below |
| G | `typescript` 7 | — | **Blocked upstream** — see below |

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
for typescript-eslint#10940.

## Deferred: TypeScript 6

TypeScript 6.0.3 is inside typescript-eslint's supported range, but it is a deprecation
migration rather than a version bump. A scratch branch found four blockers:

1. `@types/node` is no longer included implicitly, so every tsconfig needs `types: ["node"]`.
2. tsup 8's DTS plugin injects `baseUrl`, which TS 6 rejects as deprecated-to-be-removed in
   TS 7 (`TS5101`). tsup 9 removes it, so this blocker is already resolved by wave C.
3. `TS6059` rootDir errors for imports that resolve to other workspace packages' sources.
4. `apps/web` imports core types that TS 6 no longer resolves through the core index.

TS 6 is not a prerequisite for TS 7 and buys nothing on its own, so it stays closed (#26)
until typescript-eslint supports TS 7 and the two can be evaluated together.

## Deferred: undici 8

undici 8 isolates its global dispatcher from Node's built-in `fetch` ("isolate global
dispatcher v2"), so `setGlobalDispatcher(new MockAgent())` no longer intercepts the calls the
adapters make. Five adapter test files would need a different interception path for a
package that only ships in tests. Keep undici 7 until the adapters have an injectable fetch
boundary or the tests move to undici's own `fetch`.

## Wave notes

**A — ESLint 10.** `eslint@10.14.0` and `@eslint/js@10.0.1` need
`^20.19.0 || ^22.13.0 || >=24`; `typescript-eslint@8.72.1` peers `eslint: ^8.57.0 || ^9.0.0 || ^10.0.0`.
The repo already used flat config, and `globals@17` only removes outdated global sets. The
one real change was `no-useless-assignment` entering the recommended set, which found two
dead assignments (both fixed in the same PR).

**B — Vitest 5.** Needs `^22.12.0 || ^24.0.0 || >=26.0.0`; peers `vite: ^6.4.0 || ^7.0.0 || ^8.0.0`,
and the lockfile already resolves vite 7.3.7 through the coverage tooling. No test changes
were needed for clear-mocks-by-default. `vi.fn` widened to `Mock<Procedure | Constructable>`,
so one fake Redis in `scoring-lock.test.ts` now declares its `eval` function type explicitly.

**C — tsup 9.** Needs `^22.18.0 || ^24.11.0 || >=26.0.0`. Every library and app builds through
tsup, so `pnpm build` (all ten targets, declaration bundles included) is the real gate.

**D — commitlint 21 and lint-staged 17.** commitlint needs Node >= 22.12.0; lint-staged 17
declares **>= 22.22.1**, above the current local Node 22.20.0. It runs correctly there, but
the next local runtime bump should reach 22.22.x to be inside the supported range. CI installs
the latest 22.x.
