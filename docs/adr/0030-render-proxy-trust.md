# ADR-0030 — Render proxy trust and blueprint headroom

- Status: Accepted (Phase 7)
- Date: 2026-11-03
- Spec: §10.5 (client identity), §15 (Render topology)
- Finding: M-12

## Context

The Render blueprint runs the API and worker from prebuilt images behind
Render's load balancer. Two questions were open:

1. **Proxy trust.** `TRUST_PROXY=true` made Fastify derive `request.ip` from
   `X-Forwarded-For`, and `clientIp()` also preferred `CF-Connecting-IP`
   whenever that flag was set. On the VPS nginx overwrites both headers. On
   Render there is no Cloudflare, so a client could send
   `CF-Connecting-IP: 203.0.113.9` and choose its own rate-limit bucket and
   `auth_tokens.created_ip`.
2. **Headroom.** API and worker ran on `0.5c-512mb` with a 384 MB Node heap. The
   all-board rebuild, adapter buffers and the Postgres pool were the known
   pressure points.

The Render docs confirm the relevant topology: the service port is **not**
directly reachable from the internet; Render's load balancer terminates TLS and
forwards HTTP to the service. The docs do not promise a Cloudflare-style
single-value client header, so `TRUST_PROXY` (for `X-Forwarded-For`) stays, and
`CF-Connecting-IP` must not be trusted there.

## Decision

1. **New `TRUST_CF_CONNECTING_IP` flag** (default `false`). `clientIp()` only
   reads `CF-Connecting-IP` when both this flag and `TRUST_PROXY` are true. The
   VPS `.env.production` and `docker-compose.prod.yml` set it; Render leaves it
   at the default. The flag is threaded through the global limiter, the auth
   routes and the SSE counter, which all derive identity the same way.
2. **Keep `TRUST_PROXY=true` on Render** because the service is proxy-only and
   Fastify needs it to see the client address. `X-Forwarded-For` remains the
   platform's header; the blueprint does not enable the Cloudflare-specific
   path.
3. **Raise the runtime plans.** API and worker move from `0.5c-512mb` to
   `1c-2g`; the worker heap cap rises from 384 MB to 1.5 GB. API shutdown
   delay drops to 60 s (it has no in-flight batches to drain); the worker
   keeps 120 s for BullMQ.
4. **Record the verification limit.** Render's docs describe the proxy-only
   topology but not header-by-header sanitisation. The trust decision therefore
   relies on the flag split above rather than on an unverified header promise;
   if Render later exposes a client-IP header, it can be adopted behind the
   same flag.

## Consequences

- A forged `CF-Connecting-IP` on Render no longer changes any rate-limit or
  audit identity. On the VPS behavior is unchanged (nginx writes the header).
- The `ip:` bucket on Render is keyed by `request.ip` (the XFF hop Render
  supplies), which is the platform-supported path.
- The bill increases: two `1c-2g` services instead of two `0.5c-512mb` ones.
  That is the cost of running the all-board rebuild without OOM risk.
- `TRUST_CF_CONNECTING_IP` is a new name and is recorded in
  `docs/SPEC_REVIEW.md`.

## Verification

- `apps/api/src/plugins/rate-limit.test.ts`: `clientIp`/`rateLimitKey` ignore
  `CF-Connecting-IP` when the flag is false and honor it when true.
- `render.yaml`: API/worker `plan: 1c-2g`, `maxShutdownDelaySeconds` 60/120,
  worker heap 1536 MB; the blueprint no longer sets the CF flag.
- `docker-compose.prod.yml` sets `TRUST_CF_CONNECTING_IP=true` next to
  `TRUST_PROXY`, and `.env.production.example` documents it.
