/**
 * Typed application errors (spec §5.3). The API maps these to RFC 7807
 * problem+json responses in apps/api/src/plugins/errors.ts.
 */
export abstract class AppError extends Error {
  abstract readonly status: number;
  abstract readonly type: string; // RFC 7807 "type" suffix

  constructor(
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export class NotFoundError extends AppError {
  override readonly status = 404;
  override readonly type = 'not-found';
}

export class ValidationError extends AppError {
  override readonly status = 400;
  override readonly type = 'validation-error';
}

export class UnauthorizedError extends AppError {
  override readonly status = 401;
  override readonly type = 'unauthorized';
}

export class ForbiddenError extends AppError {
  override readonly status = 403;
  override readonly type = 'forbidden';
}

export class ConflictError extends AppError {
  override readonly status = 409;
  override readonly type = 'conflict';
}

/**
 * Spec §9.3/§16 — a leaderboard cursor whose run was rebuilt (thinned) while
 * the client was paginating; the client restarts without the cursor.
 */
export class CursorExpiredError extends AppError {
  override readonly status = 410;
  override readonly type = 'cursor-expired';
}

export class RateLimitedError extends AppError {
  override readonly status = 429;
  override readonly type = 'rate-limited';
}

/** Redis-backed surfaces (SSE) when their store is missing or down (spec §5.3). */
export class UnavailableError extends AppError {
  override readonly status = 503;
  override readonly type = 'unavailable';
}

/** Upstream error with retry semantics, used by workers (not exposed via API). */
export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly status: number | null,
    readonly retryAfterMs: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}
