import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  RateLimitedError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
} from './errors.js';

const CASES = [
  { make: () => new NotFoundError('x'), status: 404, type: 'not-found' },
  { make: () => new ValidationError('x'), status: 400, type: 'validation-error' },
  { make: () => new UnauthorizedError('x'), status: 401, type: 'unauthorized' },
  { make: () => new ForbiddenError('x'), status: 403, type: 'forbidden' },
  { make: () => new ConflictError('x'), status: 409, type: 'conflict' },
  { make: () => new RateLimitedError('x'), status: 429, type: 'rate-limited' },
];

describe('AppError', () => {
  it.each(CASES)('$type maps to $status', ({ make, status, type }) => {
    const error = make();
    expect(error).toBeInstanceOf(AppError);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBe(status);
    expect(error.type).toBe(type);
    expect(error.message).toBe('x');
  });

  it('carries optional details', () => {
    const error = new ValidationError('bad input', {
      errors: [{ path: 'q', message: 'required' }],
    });
    expect(error.details).toEqual({ errors: [{ path: 'q', message: 'required' }] });
  });

  it('UpstreamError keeps retry metadata and is not an AppError', () => {
    const error = new UpstreamError('github 503', 'github', 503, 30_000, true);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AppError);
    expect(error.source).toBe('github');
    expect(error.status).toBe(503);
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.retryable).toBe(true);
  });
});
