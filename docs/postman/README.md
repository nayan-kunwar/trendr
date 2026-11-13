# Trendr Postman collection

A hand-authored Postman v2.1 collection covering **all 46 paths / 56 operations** of the Trendr
API, plus the health, Mailpit and negative-path checks the OpenAPI document cannot express.

| File | Purpose |
| --- | --- |
| `Trendr.postman_collection.json` | The collection (8 folders, 74 requests). |
| `Trendr.local.postman_environment.json` | Local stack: API `:4000`, web `:3000`, Mailpit `:8025`. |
| `Trendr.production.postman_environment.json` | Placeholder origins; fill in the real values locally. |

The collection is checked against `apps/api/openapi.json` by
[`scripts/check-postman.mjs`](../../scripts/check-postman.mjs). CI fails if an operation is missing or
a request targets a path the API does not expose. Add new routes to both the collection and the
OpenAPI export in the same change.

## Prerequisites

1. A running stack with PostgreSQL, Redis and Mailpit. The usual local command is:

   ```bash
   docker compose up -d --build --wait postgres redis migrate api worker web mcp mailpit
   ```

2. A seeded database and a scored board. Boards are produced by a scoring run, not by the seed
   alone:

   ```bash
   pnpm db:seed
   pnpm worker:score
   # or: POST /v1/admin/score {"source":"all"} with an admin key
   ```

3. The seed prints the development API key. Copy it into the `adminApiKey` environment variable:

   ```text
   seed: API key (dev, scopes read+admin): dt_live_...
   ```

4. If `METRICS_TOKEN` is set in `.env`, put the same value in `metricsToken`; otherwise the metrics
   request asserts 401 and the rest of the collection is unaffected.

## Import

1. Postman → **Import** → select the three JSON files (or the whole `docs/postman` folder).
2. Choose the **Trendr local** environment in the top-right selector.
3. Open the environment and set `adminApiKey` (and optionally `metricsToken`). Leave `accessToken`
   and the other captured variables empty; the collection fills them.

The collection never contains a real token or key. `accessToken`, `adminApiKey`, `createdApiKey`,
`magicLinkToken` and `metricsToken` are secret-typed variables.

## Run order

Run the folders top to bottom:

| Folder | Requests | What it covers |
| --- | --- | --- |
| `00 Health & meta` | 4 | `/healthz`, `/readyz`, `/metrics`, `/openapi.json` |
| `01 Auth` | 9 | OAuth providers/callback, magic link → Mailpit → verify → `/v1/me` → refresh |
| `02 Public` | 15 | trending, lookup, item detail (+ conditional ETag), history, scores, explain, aliases, search, new, topics, languages, compare, stats |
| `03 Me` | 18 | watchlists, alerts, digest, API-key create/use/revoke |
| `04 Admin` | 14 | all five ingest variants, scoring, runs, queues, DLQ, rate limits, item patch |
| `05 Negative` | 6 | 401/403 paths, missing CSRF header, revoked key |
| `06 Manual` | 5 | SSE stream, unsubscribe (needs an email token), OAuth start (needs a configured provider), admin-via-JWT (needs an admin user) |
| `99 Destructive` | 3 | logout, refresh-after-logout, delete the throwaway user |

`02 Public` is self-contained: it saves the item IDs that later folders use. `03 Me` depends on the
`accessToken` from `01 Auth` and the `itemId` from `02 Public`. `05 Negative` depends on the revoked
key from `03 Me` and the refresh cookie from `01 Auth`. Run in order.

### Newman

Newman runs the deterministic folders (`00`–`05`) plus `99 Destructive`, which cleans up the
throwaway user in the same invocation. It cannot run `06 Manual`: the SSE request stays open until
cancelled, the unsubscribe request needs a token from a real email, and OAuth start needs provider
credentials. Use Postman for `06`.

```bash
npx --yes newman run docs/postman/Trendr.postman_collection.json \
  -e docs/postman/Trendr.local.postman_environment.json \
  --folder "00 Health & meta" \
  --folder "01 Auth" \
  --folder "02 Public" \
  --folder "03 Me" \
  --folder "04 Admin" \
  --folder "05 Negative" \
  --folder "99 Destructive"
```

If a Newman run stops before `99`, delete the throwaway `postman-<timestamp>@example.test` user
manually or leave it; it has no privileges.

## Auth model

- **`01 Auth`** sends a magic link to a fresh `postman-<timestamp>@example.test` address. Magic links
  are limited to 3 per email per hour, so every run gets a new address. It also checks OAuth
  provider discovery and that an invalid OAuth callback redirects to the web error page; the
  provider round-trip itself is opt-in in `06 Manual` because it needs real client credentials.
- **Mailpit** (`http://localhost:8025`) is queried through its HTTP API. The second request extracts
  the token from the `/auth/verify#token=…` link. This folder only works locally.
- **`03 Me`** uses Bearer `{{accessToken}}`. API keys are deliberately rejected on `/v1/me/*`.
- **`04 Admin`** uses `X-API-Key: {{adminApiKey}}` (the seeded `read+admin` key; it rotates on every
  `pnpm db:seed`, so copy the newly printed value). An admin-role JWT
  also works; `06 Manual` has an optional request for that path.
- **Cookie writes** (`refresh`, `logout`) need `x-requested-with: trendr`. Postman's cookie jar
  captures `dt_refresh` from the verify response automatically.
- Use **`localhost`**, not `127.0.0.1`, in `baseUrl` and `mailpitUrl`. Cookies are host-scoped, and
  mixing the two names splits the cookie jar.

## Variables

| Variable | Set by | Used by |
| --- | --- | --- |
| `baseUrl` | environment | every API request |
| `webUrl` / `mailpitUrl` | environment | link context / Mailpit |
| `adminApiKey` | you (seed output) | Admin folder, negative API-key tests |
| `metricsToken` | you (optional) | `/metrics` |
| `userEmail` | magic-link pre-request | Mailpit filter, verify assertion |
| `oauthProvider` | collection (`google`) | OAuth start/callback path; set `github` to exercise the other provider |
| `magicLinkToken`, `mailpitMessageId` | Mailpit requests | verify |
| `accessToken` | verify / refresh | Me, Negative, Destructive |
| `itemId`, `itemSource`, `itemExternalId`, `secondItemId` | trending | lookup, item routes, compare, alerts, watchlists |
| `runId` | trending | informational (scoring run) |
| `adminRunId` | admin runs list (defaults to `0`) | run detail |
| `jobId` | ingest | informational queue job id |
| `dlqJobId`, `dlqJobId2` | DLQ list (default to `0`) | DLQ retry (first) and delete (second) |
| `watchlistId`, `alertId`, `apiKeyId` | create responses | follow-up CRUD |
| `createdApiKey` | API-key create | use/revoke negative test |
| `unsubscribeToken` | you (from an email) | `06 Manual` |
| `cursor`, `etag`, `itemEtag`, `lastEventId` | responses | pagination, conditional GET, SSE resume |

## Production environment

`Trendr.production.postman_environment.json` contains placeholders only. Before using it, set
`baseUrl` and `webUrl` to the deployed origins and paste an admin key into `adminApiKey`. There is no
Mailpit in production, so `01 Auth` cannot extract a magic-link token automatically; either skip that
folder or paste a token from a real mailbox into `magicLinkToken` and run the verify request.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `429` on a rerun | The anonymous tier is 60 requests/minute per IP, and the public folders use most of it. Wait for `Retry-After` (about a minute) and rerun. |
| `429` on the magic link | 3 links per email per hour. The collection generates a new address each run; a manual rerun within the same second can collide — wait or change `userEmail`. |
| `trending` has an empty `data` array | The board has not been scored. Run `pnpm worker:score` or `POST /v1/admin/score`. |
| `401` on `/metrics` | `metricsToken` is empty or does not match `METRICS_TOKEN`. |
| `403` on the Admin folder | `adminApiKey` is missing, revoked, or lacks the `admin` scope. |
| `401` on refresh | The `dt_refresh` cookie is missing. Run `01 Auth` first and keep `localhost` consistent. |
| DLQ retry/delete return `404` | The DLQ has fewer than two failed jobs, so `dlqJobId`/`dlqJobId2` stayed `0`. That is the expected result; populate the DLQ to exercise the success path. |
| Get run returns `404` | No runs exist yet, so `adminRunId` stayed `0`. That is the expected result; ingest something to create a run. |
| SSE request hangs in Newman | Postman buffers the stream until it is cancelled; run it from Postman, not Newman. |

## Drift guard

```bash
node scripts/check-postman.mjs
```

It normalizes path parameters (`{id}`, `:id`, `{{itemId}}` all become `{}`), skips Mailpit and the
hidden `/openapi.json` route, and reports coverage. CI runs it in the `lint-typecheck-unit` job.
