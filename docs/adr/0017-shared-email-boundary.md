# 0017 — Shared email boundary for API magic links and worker notifications

- Status: Accepted
- Date: 2026-10-21
- Phase: 7 (7.1)
- Source: TRENDR_SPEC.md §13.3, §18 task 7.1

## Context

Spec §13.3 places the `EmailSender` interface and the Resend/SMTP implementations under
`apps/worker/src/notify/email.ts`. Phase 7.1 also needs the same transport in the API to deliver
passwordless magic links. Duplicating the implementation would create two provider configurations,
two error-handling paths, and a drift risk when the worker adds alert and digest templates.

## Decision

1. Add `packages/email` with the provider-neutral `EmailMessage`/`EmailSender` types and the
   `SmtpEmailSender`, `ResendEmailSender` and `LogEmailSender` implementations.
2. `createEmailSender({ provider, from, smtpUrl, resendApiKey })` is the only construction point;
   the API and worker both pass values from their typed `@trendr/config` env object.
3. The package has no dependency on the domain layers. Templates remain in their consumer (the API
   magic-link renderer now, worker React Email templates later), so the transport can be reused
   without coupling it to either app.
4. `LogEmailSender` exists for local/test use where SMTP is not running; production continues to
   use Mailpit/SMTP in development and Resend in production.

## Consequences

- The API image and the worker image both include the package through the normal Turbo prune graph.
- Resend idempotency keys are part of `EmailMessage` but the current Resend SDK call does not yet
  send them; when the SDK exposes a stable option the transport can use it without changing callers.
- Worker alerts/digests (tasks 7.4/7.5) can import the same sender, keeping `SMTP_URL`,
  `EMAIL_PROVIDER` and `EMAIL_FROM` semantics identical across processes.
