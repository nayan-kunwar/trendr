# ADR-0021 — Deployment topology: VPS primary, Render alternative

- Status: Accepted (Phase 10)
- Date: 2026-11-02
- Spec: §17.6

## Context

The spec's primary deployment is one VPS behind Cloudflare: nginx terminates
TLS, routes `/v1` to the API, `/mcp` to the MCP server and `/` to the web app,
and Postgres/Redis run as Compose services. That topology is the cheapest
always-on option and keeps every component on a private Docker network, but
acceptance is blocked until the owner supplies a domain, VPS/SSH access, a
Cloudflare origin certificate and backup credentials.

Render's Blueprint is the managed alternative for the same four processes plus
Postgres and Redis-compatible Key Value. It removes host and proxy maintenance,
but it changes the origin model, the image build inputs, the migration entry
point and the cost structure. This ADR records those differences so the two
paths stay deliberate rather than drifting.

## Decision

1. **The VPS path remains the primary production topology.** `render.yaml` is a
   complete, independently deployable alternative for a demo or a short-lived
   environment. It is not a second production deployment and does not replace
   `docker-compose.prod.yml` or `infra/nginx/trendr.conf`.
2. **Render deploys prebuilt GHCR images, not Dockerfiles.** Render Blueprints
   have no `dockerBuildArgs`, and the web image bakes `NEXT_PUBLIC_API_URL` at
   build time. The publish workflow already produces `linux/amd64` images (it
   also builds `linux/arm64` for the VPS), so the Blueprint references
   `ghcr.io/nayan-kunwar/trendr-{api,worker,web,mcp}:latest`. Private packages
   need a Render registry credential; public packages need none.
3. **Mixed plan allocation.** The API, worker, Postgres and Key Value are
   paid; web and MCP are free. The API must be a paid web service for
   `preDeployCommand` to run migrations. There is no free background worker at
   Render, and the free Postgres expires 30 days after creation, so neither can
   be used for a durable demo. The worker uses the cheapest plan
   (`0.5c-512mb`) with `NODE_OPTIONS=--max-old-space-size=384`; if scoring
   outgrows it, raise the worker to `1c-2g` before raising the heap.
4. **Render uses split origins.** The web app is `trendr-web.onrender.com` and
   the API is `trendr-api.onrender.com`; there is no nginx and no single-origin
   `/v1` path. `API_INTERNAL_URL`, `NEXT_PUBLIC_API_URL` and `CORS_ORIGINS` all
   use the API/public web HTTPS origins. Render's `fromService` only exposes
   `host`, `port`, `hostport` and `connectionString`, none of which composes a
   URL with the required scheme, and free web services cannot receive private
   traffic. The cost is one public hop for server-side rendering and MCP calls;
   the benefit is that the topology works with free web services and needs no
   proxy.
5. **The refresh cookie follows the origin model.** `onrender.com` is on the
   Public Suffix List, so `trendr-web.onrender.com` and
   `trendr-api.onrender.com` are cross-site even though they look like
   subdomains. The Blueprint therefore sets `COOKIE_SAME_SITE=none`, which the
   env schema only permits with `NODE_ENV=production` because the browser
   requires a Secure cookie for `SameSite=None`. The refresh route keeps the
   CORS allowlist and the `X-Requested-With: trendr` CSRF header. Custom
   subdomains under one registrable domain (for example `app.example.com` and
   `api.example.com`) are same-site and should use `lax`, which is stricter and
   avoids third-party-cookie blocking (Safari blocks cross-site cookies, and
   other browsers may partition or throttle them).
6. **The web image and the deployment must agree on the API origin.** The
   publish workflow's `API_PUBLIC_URL` repository variable must equal the API
   origin in `render.yaml`. Changing the API host means re-publishing web, not
   only changing an env var: Next bakes the value into the browser bundle, and
   the runtime copy drives the middleware's CSP `connect-src`. The runbook
   documents the order: publish API/worker/MCP images, publish web with the
   final API URL, then sync the Blueprint (or redeploy web).
7. **Migrations run from the API's pre-deploy command.** The API service runs
   `node packages/db/dist/migrate.js` before each new instance starts.
   Migrations remain backward compatible (expand → migrate → contract) so a
   rollback to the previous image is safe while the schema is compatible. On
   the first Blueprint sync the worker may start before that migration and
   crash-loop until Render restarts it; deploy the API first, then the worker.
   Subsequent deploys are ordered by the same pre-deploy command.
8. **Render Postgres and Key Value stay private.** Both use `ipAllowList: []`;
   the API and worker reach them over Render's private network through
   `fromDatabase.connectionString` and `fromService.connectionString`. Key Value
   uses `noeviction` because BullMQ must not lose queued jobs, and
   `journal-snapshot` because a queue without persistence loses accepted work on
   restart. A workstation needs a temporary allow-list entry for `psql` or a
   restore drill.
9. **The Blueprint uses demo-sized caps.** `TRACKED_MAX_*` follows the §6.5
   low-tier settings, snapshots are kept for 2 months, and scores keep 24 hourly
   hours plus 30 daily days. The Postgres disk is 15 GB. The spec's full-size
   estimate also lands at about 15 GB, so these caps preserve headroom and
   reduce upstream traffic. `daily_metrics` has no retention job yet (see
   GAP-9); the caps are the only control on its growth.

## Costs (checked 2026-11-02, USD)

| Component | VPS path | Render path |
| --- | --- | --- |
| Compute | Hetzner CX22-class 2 vCPU / 4 GB, ≈ €4–5/month | API `0.5c-512mb` $7 + worker `0.5c-512mb` $7 + free web/MCP |
| Postgres | included in the VPS (container) | `0.5c-1g` $19 + 15 GB disk ≈ $23 (1 GB included, $0.30/GB beyond) |
| Redis | included in the VPS (container) | Key Value `256mb`, $10 |
| Proxy/TLS | nginx + Cloudflare Origin Certificate, $0 | Render edge TLS, $0 |
| Backups | S3/R2/B2 bucket + egress, ≈ $1–2 | PITR (3 days on Hobby, 7 on Pro) + on-demand logical exports (7-day retention) |
| Total | **≈ $6–8/month** plus domain | **≈ $47/month** plus bandwidth overages |

Render's Hobby workspace includes 5 GB outbound bandwidth and 500 build minutes
per month. Image-backed services do not consume build minutes, but the web/MCP
free services do consume outbound bandwidth. If the API is idle it does not
spin down because it is paid; the free web and MCP services do.

## Free-tier limits that shaped the decision

| Service | Free allowance | Why it is not the durable production path |
| --- | --- | --- |
| Render web | 512 MB, shared 750 instance-hours/month, spins down after 15 min idle, 5 GB bandwidth | Cold starts of about a minute; free services cannot receive private traffic; two free services can exhaust 750 hours if kept warm |
| Render worker | none | No scheduler/ingest without a paid instance |
| Render Postgres | 1 GB, one per workspace, expires 30 days after creation (14-day grace) | Not durable; no backups/pooling |
| Render Key Value | 25 MB, one per workspace, in-memory, 50 connections, no persistence | Cannot hold BullMQ jobs across a restart |
| Neon Postgres | 1 GB/project, 20 GB/account, 100 CU-hours/project, 5-minute scale-to-zero | Scale-to-zero and the 1 GB cap; the spec's 0.5 GB assumption is conservative, but `daily_metrics` still has no retention |
| Upstash Redis | 250 MB, 500K commands/month, 10 GB bandwidth | BullMQ polling/blocking burns commands; use it as a cache only |
| Resend | 3,000 emails/month, 100/day | Fine for magic links and a small digest list; verify the domain |
| Vercel Hobby | free, non-commercial, 100 GB transfer/1M requests | Next.js front end only; cannot host the worker or BullMQ |
| Fly.io | no free tier for new organizations; 2-hour/7-day trial | Cheapest always-on 256 MB Machine is about $2.19/month, plus Postgres/Redis |
| Oracle Always Free | Arm Ampere allowance (verify region/capacity) | Capacity is often unavailable and idle resources can be reclaimed; not a guaranteed demo host |

## Consequences

- The VPS remains the only path with a single origin (`https://host/v1`,
  `https://host/mcp`, `https://host/`) and no cross-origin preflight for the
  web app's server-side calls.
- Render's default `onrender.com` names are not guaranteed: Render appends a
  suffix if a name is taken. The Blueprint writes the expected URLs out; a
  suffix or a custom domain requires editing `render.yaml` and re-publishing
  the web image with the matching `API_PUBLIC_URL`.
- On the default `onrender.com` hosts the refresh cookie is cross-site
  (`SameSite=None`). Safari blocks third-party cookies by default, so session
  restore may fail there; other browsers may partition or throttle them. For a
  browser-complete demo, use custom subdomains under one registrable domain and
  set `COOKIE_SAME_SITE=lax`.
- Image-backed services do not auto-deploy when `latest` moves. Use a manual
  deploy, a pinned release tag, or a Render deploy hook after the publish
  workflow. The VPS path pulls and restarts explicitly, which is the same
  operational model.
- Free web/MCP cold starts are user-visible. Do not add uptime monitors that
  keep both awake unless the 750-hour allowance is acceptable.
- Render provides logs, metrics and paid Postgres backups, but the Blueprint
  does not provision Prometheus/Grafana. The VPS `obs` profile and the
  `METRICS_TOKEN`-guarded endpoints remain the full observability path.
- Key Value `noeviction` returns write errors when full instead of silently
  dropping jobs; monitor memory and queue depth.
- The free Postgres and free Key Value limits are not used, so the Blueprint
  costs about $47/month even for a demo. The VPS is still the cost-effective
  production choice.
