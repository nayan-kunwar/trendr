# 0013 — Fine-grained PAT expiry is surfaced, not guessed (GAP-8)

- Status: Verified (header observed live 2026-10-19: `2027-01-17 16:40:21 UTC`)
- Date: 2026-10-19
- Phase: 4 (4.3)
- Source: TRENDR_SPEC.md §7.3.1/§14.1; GAP-8

## Context

A fine-grained GitHub PAT expires on a fixed date; when it does, every ingest
job for the source starts failing with 401s and the only signal is the failure
itself. GitHub exposes the expiry non-standardly as the
`github-authentication-token-expiration` response header on requests made with
such a token. The spec records this as GAP-8 (expiry metric, to be settled with
the GitHub adapter).

## Decision

- The adapter reads the header **opportunistically on responses it already
  decodes** (REST `onHeaders` path): present → parse (`'YYYY-MM-DD HH:MM:SS UTC'`,
  handled by `Date.parse`) and report `{tokenIndex, expiresAt}` through
  `AdapterContext.onTokenExpiry`; absent or unparsable → ignored (classic PATs
  never send it).
- The worker sets `trendr_source_token_expires_timestamp_seconds{source,token_index}`
  for every report, so Prometheus can alert ahead of time, and logs a warning
  when ≤ 14 days remain. No extra request is made — this piggybacks on traffic
  that already happens.
- The recorder (`record.ts`) captures the raw header it sees into
  `__fixtures__/meta.json` so the first live run turns this from provisional
  into verified without code changes.
- Verified live (2026-10-19): every REST response carried
  `github-authentication-token-expiration: 2027-01-17 16:40:21 UTC`; the
  recorder stored the raw value in `meta.json` and `Date.parse` handles the
  format as designed.

## Consequences

- Expiry is visible in metrics/logs before rotation becomes urgent; an absent
  header (classic token) leaves the gauge unset, which is the correct "unknown".
- Token identifiers stay the bucket index, never the secret itself — fixtures
  are scanned for token-shaped strings by a unit test.
