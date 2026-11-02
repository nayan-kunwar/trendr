# Trendr operations runbook

This runbook covers the operational surface: metrics, dashboards, alerts,
retention/rollup jobs, partition checks, credential rotation, common incidents,
production deployment, and backup/restore. All times are **UTC** unless stated
otherwise. Commands assume the repository root and the local Compose stack from
§17; production commands use `docker-compose.prod.yml` as shown in §6.

## 1. Observability

### Endpoints

| Surface | URL / access |
| --- | --- |
| API metrics | `http://localhost:4000/metrics` with `Authorization: Bearer $METRICS_TOKEN` |
| Worker health | `/healthz` liveness; `/readyz` readiness (503 when Redis is down): `docker compose exec worker node -e "fetch('http://localhost:9464/readyz').then(r=>process.exit(r.ok?0:1))"` |
| Worker metrics | internal only; Prometheus scrapes `worker:9464` with `METRICS_TOKEN` |
| Prometheus | `http://localhost:9090` (profile `obs`) |
| Grafana | `http://localhost:3001`; dashboard **Trendr Overview** |
| Jaeger | `http://localhost:16686` (optional tracing, §14.6) |

```bash
# Start the core stack, then the observability profile.
docker compose up -d --wait
docker compose --profile obs up -d prometheus grafana
pnpm obs:smoke   # rules + targets + provisioned dashboard

curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" http://localhost:4000/metrics |
  grep -E '^# HELP trendr_'
```

`METRICS_TOKEN` is rendered by Compose into a read-only file
(`/etc/prometheus/metrics.token`, via `configs.content`) because Prometheus
deliberately does not expand environment variables inside config files
(prometheus/prometheus#2357). Change it in `.env` (or the platform secret
store) and restart Prometheus. Never publish worker port 9464.

### Alert rules

`infra/prometheus/alerts.yml` contains the six §14.2 rules:
`IngestionStale`, `UpstreamRateLimited`, `DeadLetterGrowing`,
`ApiHighErrorRate`, `ApiSlowLeaderboard`, `SnapshotsDefaultNotEmpty`.

Validate before shipping:

```bash
docker run --rm \
  -v "$PWD/infra/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v2.55.1 \
  check rules /etc/prometheus/alerts.yml
```

Prometheus loads rules by `rule_files`; after editing, reload with
`curl -X POST http://localhost:9090/-/reload` (or restart the container).

### Useful PromQL

```promql
# API 5xx ratio and p95
sum(rate(trendr_http_requests_total{status=~"5.."}[5m]))
  / sum(rate(trendr_http_requests_total[5m]))
histogram_quantile(0.95, sum by (le) (rate(trendr_http_request_duration_seconds_bucket[5m])))

# Pipeline
sum by (queue, state) (trendr_queue_depth)
max by (source, tier) (trendr_data_freshness_seconds)
sum by (source, kind) (increase(trendr_source_api_errors_total[15m]))
histogram_quantile(0.95, sum by (le, source) (rate(trendr_ingestion_duration_seconds_bucket[15m])))

# Cache, tokens, and the partition guard
sum by (cache) (rate(trendr_cache_requests_total{result="hit"}[15m]))
  / clamp_min(sum by (cache) (rate(trendr_cache_requests_total[15m])), 1e-9)
time() < trendr_source_token_expires_timestamp_seconds
max(trendr_snapshots_default_rows)
```

Worker metrics are scraped from a separate registry; use the Prometheus
`job="worker"` selector when a metric name exists on both processes (for
example `trendr_db_pool_connections`).

## 2. Manual maintenance jobs

All jobs are idempotent. The CLI enqueues the real BullMQ job onto the
`maintenance` queue and waits for completion, so the **running worker** executes
it and updates worker gauges (especially `trendr_snapshots_default_rows`).

```bash
# Build once (or rebuild after a deploy).
pnpm --filter @trendr/worker build

# Run inside Compose (the worker image contains dist/maintenance-cli.js).
docker compose exec worker node dist/maintenance-cli.js create-partitions
docker compose exec worker node dist/maintenance-cli.js rollup-daily
docker compose exec worker node dist/maintenance-cli.js retention
docker compose exec worker node dist/maintenance-cli.js cleanup-tokens
docker compose exec worker node dist/maintenance-cli.js retier-items
```

Locally, with `.env` loaded and a live worker:

```bash
pnpm --filter @trendr/worker maintenance -- retention
```

If the worker is not running, calling the processor SQL directly from `psql` is
safe for the data but does **not** update the worker metric:

```sql
-- create partitions (0..+3 months)
SELECT ensure_snapshot_partitions(0, 3);
SELECT count(*) AS snapshots_default_rows FROM snapshots_default;

-- rollup a specific UTC day
INSERT INTO daily_metrics (item_id, metric, day, value)
SELECT DISTINCT ON (item_id, metric) item_id, metric, DATE '2026-10-19', value
FROM snapshots
WHERE captured_at >= DATE '2026-10-19' AND captured_at < DATE '2026-10-20'
  AND metric IN ('stars','forks','likes','upvotes','downloads_total','comments','watchers')
ORDER BY item_id, metric, captured_at DESC
ON CONFLICT (item_id, metric, day) DO UPDATE SET value = EXCLUDED.value;

-- drop whole snapshot partitions older than 3 months
SELECT drop_old_snapshot_partitions(3);
```

### Schedules

| Job | UTC schedule | What it does |
| --- | --- | --- |
| `rollup-daily` | `20 0 * * *` | previous-day end-of-day values → `daily_metrics` |
| `create-partitions` | `0 1 * * *` | `ensure_snapshot_partitions(0, 3)` + default-row gauge |
| `retention` | `30 3 * * *` | snapshot partitions, scores, alert events, ingestion runs |
| `cleanup-tokens` | `0 4 * * 0` | auth tokens expired/revoked > 7 days |
| `retier-items` | `0 5 * * *` | hot/warm/cold re-tiering |

Schedules are registered by the worker role containing `scheduler`; inspect them
with `docker compose logs worker | grep scheduler` or Redis/BullMQ.

### Retention policy (§6.5)

| Data | Policy | Job |
| --- | --- | --- |
| `snapshots` | drop partitions older than `SNAPSHOT_RETENTION_MONTHS` (3) | `retention` |
| `scores` | keep every run for `SCORES_HOURLY_RETENTION_HOURS` (48); then one (last) run per source/window/UTC day for `SCORES_DAILY_RETENTION_DAYS` (365); current run always kept | `retention` |
| `ingestion_runs` | 30 days, except runs referenced by kept scores/current/alert events | `retention` |
| `alert_events` | 180 days | `retention` |
| `auth_tokens` | delete 7 days after expiry/revocation | `cleanup-tokens` |
| `daily_metrics` | kept forever by default | — |

`daily_metrics` growth is about 55M rows/year for 50k items × 3 metrics. On a
small database, trim it manually in bounded batches (the retention job
deliberately does not do this):

```sql
-- Repeat until 0 rows are deleted.
WITH doomed AS (
  SELECT ctid FROM daily_metrics
  WHERE day < current_date - 400
  LIMIT 10000
)
DELETE FROM daily_metrics d USING doomed WHERE d.ctid = doomed.ctid;
```

Verify score retention (the same invariants as the integration test):

```sql
-- Every run inside 48h survives; older runs have one per day/window/source.
SELECT source, "window", (started_at AT TIME ZONE 'UTC')::date AS day,
       count(*) AS runs_kept
FROM ingestion_runs r
WHERE job_type = 'score'
  AND EXISTS (SELECT 1 FROM scores s WHERE s.run_id = r.id)
  AND started_at < now() - interval '48 hours'
GROUP BY source, "window", day
HAVING count(*) <> 1;

-- No score row may reference a missing run.
SELECT count(*) FROM scores s
LEFT JOIN ingestion_runs r ON r.id = s.run_id
WHERE r.id IS NULL;
```

### Partition guard (ISS-7)

`snapshots_default` must stay empty. A non-zero
`trendr_snapshots_default_rows` means a date range was written before its
monthly partition existed, and `CREATE TABLE ... PARTITION OF` for that range
will fail. Run `create-partitions`; if the gauge stays non-zero, inspect:

```sql
SELECT min(captured_at), max(captured_at), count(*)
FROM snapshots_default;
```

Do not drop `snapshots_default` manually while it has rows. Move rows to the
correct partition (create it first) or archive them, then re-check the gauge.

## 3. Credential rotation

### GitHub fine-grained PAT

1. Create a replacement PAT: public repositories read-only, no write scopes,
   90-day expiry; set a calendar reminder.
2. Update `GITHUB_TOKENS` in the secret store/`.env` (comma-separated; index
   order defines `github:core:{tokenIdx}` buckets).
3. Restart the worker (`docker compose up -d worker` or platform redeploy).
4. Confirm the new expiry metric and rate-limit budget:

```promql
trendr_source_token_expires_timestamp_seconds{source="github"}
trendr_rate_limit_remaining{source="github", resource="core"}
```

Old tokens can be revoked after the worker has scraped successfully.

### Hugging Face token

Read-only; update `HF_TOKEN` and restart only the worker. The API never receives
source credentials. Check `trendr_source_api_errors_total{source="huggingface"}`.

### Metrics token

Update `METRICS_TOKEN` in `.env`, restart the API/worker and Prometheus
(`docker compose up -d api worker prometheus`). Verify both targets are `up`
in Prometheus and `pnpm obs:smoke` passes.

## 4. Incident checklists

### API down / high 5xx

1. `docker compose ps api`; `docker compose logs --tail=200 api`.
2. Check `/readyz`: DB, Redis, migrations. A Redis failure is degraded (200);
   a DB or migration failure is unready (503).
3. Check `trendr_http_requests_total{status=~"5.."}` by route and
   `trendr_cache_requests_total`; a Redis breaker opens after 5 errors.
4. Roll back the last deploy or restart the API; confirm 5xx ratio drops.

### Worker down / queue backlog

1. `docker compose exec worker ... /readyz`; logs for `worker error`.
2. `trendr_queue_depth{state="waiting"}` and
   `trendr_queue_depth{queue="dead-letter",state="waiting"}`.
3. Check upstream errors (`rate_limited`, `network`, `server`) and
   `trendr_rate_limit_wait_seconds`; if rate limited, let BullMQ backoff retry.
4. If jobs are stuck `active`, restart the worker; BullMQ stalled-job recovery
   re-delivers them.
5. Inspect `/v1/admin/dlq`; replay after fixing the root cause.

### Stale data (`IngestionStale`)

1. Find the source/tier from `trendr_data_freshness_seconds`.
2. Check the source's schedules and `ingestion_runs` status/error.
3. Check the source token expiry and `trendr_source_api_errors_total`.
4. Trigger a manual ingest via `POST /v1/admin/ingest` (admin auth) or wait for
   the next scheduled run.

### Dead-letter growth

`DeadLetterGrowing` fires above 20 waiting jobs. Open `/v1/admin/dlq`, read
`failedReason`, fix the adapter/schema/config issue, then retry jobs. Dead
letters never disappear on their own; the queue is a triage surface.

### `SnapshotsDefaultNotEmpty`

Treat as critical: new snapshot inserts for that date range may be misrouted.
Run `create-partitions`, inspect `snapshots_default`, and follow §2 above.

## 5. Backups and restore

Production backups are logical `pg_dump -Fc` archives taken by
`infra/scripts/backup.sh`. `trendr-backup.timer` runs the script daily at
**02:30 UTC**; `Persistent=true` catches up after downtime.

The script:

1. writes `trendr-<UTC timestamp>.dump` atomically under `BACKUP_DIR`;
2. encrypts it with `age` when `BACKUP_AGE_RECIPIENT` is set, otherwise gzips it;
3. uploads to `S3_URI` with `--sse AES256` when configured;
4. deletes local archives older than `BACKUP_RETENTION_DAYS` (mirror that with
   an object-storage lifecycle rule).

Configuration is read from `.env.production` by the systemd unit:

```bash
sudo systemctl list-timers trendr-backup.timer
sudo systemctl start trendr-backup.service
journalctl -u trendr-backup.service -n 50 --no-pager
ls -lh /opt/trendr/backups
```

### Restore drill

Never restore over the live database. Create a scratch database from the same
Postgres container, restore into it, verify, then drop it:

```bash
cd /opt/trendr
COMPOSE='docker compose --env-file .env.production -f docker-compose.prod.yml'

$COMPOSE exec -T postgres createdb -U trendr trendr_restore

# gzip archive (default):
gunzip -c backups/trendr-YYYYMMDDTHHMMSSZ.dump.gz |
  $COMPOSE exec -T postgres pg_restore -U trendr -d trendr_restore --clean --if-exists --no-owner

# age-encrypted archive instead:
# age --decrypt --identity ~/age-key.txt backups/trendr-*.dump.age |
#   $COMPOSE exec -T postgres pg_restore -U trendr -d trendr_restore --clean --if-exists --no-owner

$COMPOSE exec -T postgres psql -U trendr -d trendr_restore -c \
  "SELECT (SELECT count(*) FROM items) AS items, (SELECT count(*) FROM snapshots) AS snapshots;"
$COMPOSE exec -T postgres dropdb -U trendr trendr_restore
```

Redis is a cache/queue, not a source of truth: back up Postgres only. Losing
Redis means boards rebuild on the next scoring run and queued jobs are lost.
Document the date and result of each restore drill.

## 6. Production deployment

The production topology is `docker-compose.prod.yml`: images come from GHCR,
only nginx publishes host ports, and Postgres/Redis/API/web/MCP stay on the
private Compose network. `infra/nginx/trendr.conf` terminates TLS with a
Cloudflare Origin Certificate and proxies `/v1`, `/mcp` and the web app.

### One-time prerequisites

| Item | Where |
| --- | --- |
| Domain proxied by Cloudflare, SSL mode **Full (strict)** | Cloudflare dashboard |
| VPS (Debian/Ubuntu), SSH access, Docker allowed | Provider |
| Cloudflare Origin Certificate | SSL/TLS → Origin Server |
| GHCR packages (public, or a PAT with `read:packages`) | GitHub |
| Secrets for `.env.production` | Password manager / secret store |
| Backup bucket + lifecycle rule | S3/R2/B2 |

The web image bakes `NEXT_PUBLIC_API_URL` at build time. Set the repository
variable `API_PUBLIC_URL` (Settings → Secrets and variables → Actions →
Variables) to the same origin as `API_PUBLIC_URL` in `.env.production` before
publishing web.

### First deploy

```bash
# 1. Publish a release tag (runs .github/workflows/publish.yml).
git tag v1.0.0
git push origin v1.0.0

# 2. On the VPS, bootstrap Docker, the deploy user, firewall and backup timer.
#    Clone the repo somewhere first so the script is available.
git clone https://github.com/nayan-kunwar/trendr.git
cd trendr
sudo ./infra/scripts/bootstrap-vps.sh

# 3. Fill the production environment (the script created it mode 600).
sudo -u deploy nano /opt/trendr/.env.production
#    Generate secrets with: openssl rand -hex 24 / openssl rand -base64 48
#    Set TRENDR_TAG=v1.0.0, API_PUBLIC_URL and WEB_PUBLIC_URL.

# 4. Install the Cloudflare Origin Certificate.
sudo -u deploy cp origin.pem origin-key.pem /opt/trendr/infra/nginx/certs/
sudo chmod 600 /opt/trendr/infra/nginx/certs/origin-key.pem

# 5. Re-run bootstrap to log in to GHCR (optional), pull and start.
sudo GHCR_USER=<github-user> GHCR_TOKEN=<read:packages-pat> \
  ./infra/scripts/bootstrap-vps.sh
```

Bootstrap is idempotent. Without the certificate or required secrets it stops
after host setup and prints what is missing.

### Verify

```bash
cd /opt/trendr
COMPOSE='docker compose --env-file .env.production -f docker-compose.prod.yml'

$COMPOSE ps
$COMPOSE logs --tail=100 migrate api worker nginx

curl -fsS https://<host>/readyz
curl -fsS 'https://<host>/v1/trending?scope=all&window=7d' | jq '.data | length'
curl -N 'https://<host>/v1/stream/leaderboard?scope=all&window=7d&limit=5'
```

The SSE command must stream the snapshot and then updates without buffering.
`/mcp` must reject requests without an `Authorization` header in production.

### Deploy a new release

```bash
cd /opt/trendr
git fetch --tags
sudo -u deploy sed -i 's/^TRENDR_TAG=.*/TRENDR_TAG=v1.1.0/' .env.production
COMPOSE='docker compose --env-file .env.production -f docker-compose.prod.yml'
$COMPOSE pull
$COMPOSE up -d --wait --wait-timeout 300
$COMPOSE ps -a migrate   # must exit 0
curl -fsS https://<host>/readyz
```

Migrations run automatically in the one-shot `migrate` service before the API
and worker start. Migrations are forward-only: rolling back the image tag is
only safe while the schema remains compatible with the older code.

### Rollback

```bash
sudo -u deploy sed -i 's/^TRENDR_TAG=.*/TRENDR_TAG=v1.0.0/' .env.production
COMPOSE='docker compose --env-file .env.production -f docker-compose.prod.yml'
$COMPOSE pull
$COMPOSE up -d --wait --wait-timeout 300
curl -fsS https://<host>/readyz
```

If the release added a migration, restore the pre-deploy backup into a scratch
database first and decide whether a schema rollback is required.

### Origin ingress and client IPs (H-1)

Only nginx publishes host ports. Two layers keep the origin from being reached
around Cloudflare:

- nginx trusts `CF-Connecting-IP` only from the generated Cloudflare range
  includes (`infra/cloudflare/nginx-real-ip.conf` and `nginx-geo.conf`). A
  connection whose peer is not Cloudflare is closed with 444 before proxying,
  and the forwarded `CF-Connecting-IP` is overwritten with `$remote_addr`.
- UFW allows 80/443 only from those ranges, and the `TRENDR-INGRESS` chain in
  `DOCKER-USER` applies the same policy to Docker's forwarded traffic. UFW's
  INPUT rules do not see DNAT'd packets, so the Docker chain is required.

The API accepts only a parseable IP from `CF-Connecting-IP` and otherwise falls
back to `request.ip`, so a malformed value cannot become a rate-limit key or an
`auth_tokens.created_ip` write.

`infra/scripts/refresh-cloudflare-ips.sh` fetches the published ranges,
regenerates the nginx includes, reloads nginx and reapplies the firewall. The
weekly `trendr-cloudflare-ips.timer` runs it; run it manually after a range
change:

```bash
sudo /opt/trendr/infra/scripts/refresh-cloudflare-ips.sh
```

Validate nginx and the two-source behaviour locally or in CI:

```bash
bash infra/scripts/verify-origin-ingress.sh
```

For debugging, do not open the origin. Tunnel to its loopback address, which
the `geo` block already allows:

```bash
ssh -L 8443:127.0.0.1:443 deploy@<vps>
curl -k https://127.0.0.1:8443/readyz
```

A Cloudflare Tunnel sidecar is not part of the current topology. If you add
one, include its Docker subnet in the `geo` block and in `TRENDR-INGRESS`, or
close 80/443 entirely and let the tunnel be the only path.

### Nginx changes

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec nginx nginx -t
docker compose --env-file .env.production -f docker-compose.prod.yml \
  exec nginx nginx -s reload
```

Cloudflare IP ranges are generated into `infra/cloudflare/` and used by
`real_ip` and the `geo` allowlist. Refresh them with
`refresh-cloudflare-ips.sh` (above), then validate and reload.

## 7. Render alternative (Blueprint)

`render.yaml` deploys the same four processes with Render Postgres and Key
Value. It is the managed alternative to §6, not a second production path; the
VPS remains primary (ADR-0021). Render pulls prebuilt GHCR images, so the
release workflow is still the source of truth.

### Prerequisites

| Item | Where |
| --- | --- |
| Render account with a payment method | Render Dashboard |
| Published images (`trendr-api`, `-worker`, `-mcp`, `-web`) | `v*` tag or manual `publish.yml` run |
| `API_PUBLIC_URL` repository variable | GitHub → Settings → Secrets and variables → Actions → Variables |
| GHCR read credential, only if the packages are private | Render Dashboard → Registry Credentials |
| Resend API key and a verified sender domain | Resend Dashboard |
| GitHub fine-grained PAT (public repos, read-only) | GitHub |
| MCP bearer token(s) and optional API key | Password manager |
| Custom domains under one registrable domain (recommended for same-site auth) | DNS provider |

The web image bakes `NEXT_PUBLIC_API_URL`. Set `API_PUBLIC_URL` to the final
API origin **before** publishing web; changing it later requires a new web
image. The Blueprint's three public URLs (`trendr-api`, `trendr-web`,
`trendr-mcp`) are written into `render.yaml` because Render cannot interpolate
one service's URL into another URL-valued variable. If Render appends a suffix
or you use custom domains, edit those values and rebuild web.

### First Blueprint sync

1. Publish a release (API/worker/MCP first, then web):

   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```

2. In Render: **New → Blueprint**, connect the repository, and apply
   `render.yaml`. Change `EMAIL_FROM` in `trendr-shared` from the placeholder to
   an address on the verified Resend domain, then enter the `sync: false` values:
   `ADMIN_EMAILS`, `RESEND_API_KEY` (API and worker), `GITHUB_TOKENS`, optional
   `HF_TOKEN`, `MCP_API_KEY`, and at least one `MCP_HTTP_AUTH_TOKENS` value.
3. Confirm the paid plans (API, worker, Postgres, Key Value). Web and MCP stay
   free.
4. On the first sync, wait for the API deploy to finish its pre-deploy
   migration before relying on the worker. If the worker crash-loops, redeploy
   it after the API reports healthy.

The Blueprint ships `COOKIE_SAME_SITE=none` because the default
`*.onrender.com` web and API hosts are cross-site; see **Auth cookies** below
before changing it.

### Verify

```bash
curl -fsS https://trendr-api.onrender.com/readyz
curl -fsS https://trendr-web.onrender.com/ >/dev/null
curl -fsS https://trendr-mcp.onrender.com/healthz
curl -fsS 'https://trendr-api.onrender.com/v1/trending?scope=all&window=7d' |
  jq '.data | length'

# MCP must reject an unauthenticated POST when MCP_HTTP_AUTH_TOKENS is set.
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://trendr-mcp.onrender.com/mcp
```

The API is paid and stays warm, so SSE should stream without a cold-start gap:

```bash
curl -N 'https://trendr-api.onrender.com/v1/stream/leaderboard?scope=all&window=7d&limit=5'
```

### Auth cookies

`onrender.com` is on the Public Suffix List, so the default
`trendr-web.onrender.com` and `trendr-api.onrender.com` hosts are **cross-site**
for cookies, not same-site subdomains. The Blueprint therefore sets
`COOKIE_SAME_SITE=none`; `NODE_ENV=production` makes the cookie `Secure`, which
browsers require for `SameSite=None`. The API env schema rejects
`COOKIE_SAME_SITE=none` outside production, and the route refuses the
combination without Secure cookies.

Cross-site refresh still requires the `CORS_ORIGINS` allowlist and the
`X-Requested-With: trendr` CSRF header; the API does not accept a bare cookie
POST. Safari blocks third-party cookies by default, and other browsers may
partition or throttle them, so session restore on the default Render hosts is
not reliable in every browser.

For a browser-complete demo, add custom subdomains under one registrable domain
you own (`app.example.com` and `api.example.com`, not two `*.onrender.com`
hosts), then set `COOKIE_SAME_SITE=lax`. Same-site subdomains work with `Lax`
even though the requests are cross-origin.

### Custom domains

Add the domains in each service's **Settings → Custom Domains** (or with
`domains:` in `render.yaml`). Keep the web and API hosts under the same
registrable domain. Then update all of:

- `trendr-shared`: `API_PUBLIC_URL`, `WEB_PUBLIC_URL`, `CORS_ORIGINS`, and
  `COOKIE_SAME_SITE=lax` once both hosts are custom subdomains of one domain.
- `trendr-web`: `NEXT_PUBLIC_API_URL`, `API_INTERNAL_URL`, `WEB_PUBLIC_URL`.
- `trendr-mcp`: `API_INTERNAL_URL`.

Re-publish the web image with the matching `API_PUBLIC_URL` after changing the
API origin. Render issues and renews TLS certificates; Cloudflare proxying is
optional and not required for this path.

### Deploy a new release

Image-backed services do not redeploy when `latest` moves. Publish the tag,
then trigger a manual deploy (or a deploy hook) for each service in this order:

1. **API** — the pre-deploy command applies migrations; wait for `/readyz`.
2. **worker** — starts against the migrated schema.
3. **web** and **MCP** — no schema dependency.

To pin a release instead of tracking `latest`, change each `image.url` in
`render.yaml` to the release tag and sync the Blueprint. Migrations remain
expand → migrate → contract, so a rollback to the previous image is safe while
the schema stays compatible.

### Limitations and operations

- Free web/MCP spin down after 15 minutes idle and take about a minute to wake.
  They share the workspace's 750 free instance-hours/month; do not keep both
  warm with an uptime monitor unless that budget is acceptable.
- Free web services cannot receive private traffic, so web/MCP call the API's
  public origin. Server-side rendering therefore pays one public hop.
- No nginx, Cloudflare origin certificate, Prometheus or Grafana run in this
  path. Use Render logs/metrics and scrape the API's `METRICS_TOKEN`-guarded
  `/metrics` from an external collector if needed.
- Postgres and Key Value have `ipAllowList: []`. For `psql` or a restore drill,
  temporarily add your workstation's IP in the Render Dashboard, then remove it.
- Key Value `noeviction` returns write errors when full instead of dropping
  queued jobs. Watch memory and queue depth. Persistence bounds loss to about a
  second on restart but is **not** a backup.
- `daily_metrics` has no retention job, so the low-tier caps in `render.yaml`
  are the main control on database growth (GAP-9).
- The Blueprint is schema-validated locally. The first live sync against a
  Render account is the remaining validation step.

### Backups and restore

Paid Render Postgres provides point-in-time recovery: 3 days on Hobby, 7 days
on Pro or higher. Use **Recovery → Restore Database** to create a recovery
instance, validate it, then point the services at it. Use **Create export** for
a logical backup; Render retains exports for seven days. Download the
`.dir.tar.gz` and restore with `pg_restore` into an empty database if you need
longer retention.

Key Value has no logical backup. BullMQ jobs are re-derived from the scheduler
after a queue loss, but jobs accepted before the loss are not recovered beyond
the journal-snapshot window.

## 8. Local Compose exposure and production boundaries

`docker-compose.yml` is a local-development topology. Postgres, Redis, and the
MCP HTTP port are published on `127.0.0.1` only, and the database uses
development credentials. Do not expose them on `0.0.0.0` or reuse this file as
a production deployment:

- Use `docker-compose.prod.yml` on the VPS; only nginx publishes `80`/`443`.
- Reach local Postgres/Redis through `docker compose exec …` or an SSH tunnel.
- Keep `MCP_HTTP_AUTH_TOKENS` unset only for local work; the MCP server refuses
  to start in any `NODE_ENV` other than `development` without it.
- Put production secrets in `.env.production`, never in a shared `.env` or git.
- Keep Redis off untrusted networks, because this topology does not configure
  Redis authentication.
