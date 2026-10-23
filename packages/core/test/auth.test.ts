import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  MAGIC_LINK_TTL_MS,
  UNSUBSCRIBE_TTL_MS,
  hashToken,
  normalizeEmail,
  randomToken,
  signUnsubscribeToken,
  timingSafeStringEqual,
  verifyUnsubscribeToken,
  weekStartUtc,
} from '../src/auth.js';

const SECRET = 'unit-unsubscribe-secret-0123456789abcdef';

describe('token helpers', () => {
  it('stores only the SHA-256 of a random token', () => {
    const raw = randomToken(32);
    expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(hashToken(raw)).toEqual(createHash('sha256').update(raw).digest());
    expect(hashToken(raw).toString('hex')).toHaveLength(64);
    expect(randomToken(32)).not.toBe(raw);
  });

  it('uses the spec magic-link and unsubscribe lifetimes', () => {
    expect(MAGIC_LINK_TTL_MS).toBe(15 * 60 * 1000);
    expect(UNSUBSCRIBE_TTL_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it('normalizes emails for citext-equivalent lookups', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com');
  });

  it('compares secrets without early exit and rejects length mismatches', () => {
    expect(timingSafeStringEqual('Bearer token-0123456789', 'Bearer token-0123456789')).toBe(true);
    expect(timingSafeStringEqual('Bearer token-0123456789', 'Bearer token-0123456788')).toBe(false);
    expect(timingSafeStringEqual('short', 'a much longer secret')).toBe(false);
    expect(timingSafeStringEqual('', '')).toBe(true);
  });
});

describe('signed unsubscribe tokens (spec §13.4)', () => {
  const expiresAt = 2_000_000_000_000;

  it('round-trips the user, purpose and expiry', () => {
    const token = signUnsubscribeToken({
      userId: '0f0f0f0f-0000-4000-8000-000000000001',
      purpose: 'digest',
      expiresAt,
      secret: SECRET,
    });
    const [payload, signature, ...rest] = token.split('.');
    expect(rest).toHaveLength(0);
    expect(signature).toHaveLength(43);
    expect(Buffer.from(payload ?? '', 'base64url').toString('utf8')).toBe(
      `0f0f0f0f-0000-4000-8000-000000000001.digest.${expiresAt}`,
    );
    expect(verifyUnsubscribeToken(token, SECRET, expiresAt - 1)).toEqual({
      userId: '0f0f0f0f-0000-4000-8000-000000000001',
      purpose: 'digest',
      expiresAt,
    });
  });

  it('rejects tampered payloads and signatures', () => {
    const token = signUnsubscribeToken({
      userId: 'user-1',
      purpose: 'alerts',
      expiresAt,
      secret: SECRET,
    });
    const [payload, signature] = token.split('.');
    const tamperedPayload = Buffer.from('user-2.alerts.' + String(expiresAt)).toString('base64url');
    expect(verifyUnsubscribeToken(`${tamperedPayload}.${signature ?? ''}`, SECRET, 0)).toBeNull();
    expect(verifyUnsubscribeToken(`${payload ?? ''}.${'A'.repeat(43)}`, SECRET, 0)).toBeNull();
    expect(verifyUnsubscribeToken(token, `${SECRET}x`, 0)).toBeNull();
  });

  it('rejects expired, malformed, and unknown-purpose tokens', () => {
    const token = signUnsubscribeToken({
      userId: 'user-1',
      purpose: 'all',
      expiresAt,
      secret: SECRET,
    });
    expect(verifyUnsubscribeToken(token, SECRET, expiresAt)).toBeNull();
    expect(verifyUnsubscribeToken('not-a-token', SECRET, 0)).toBeNull();

    const unknown = Buffer.from(`user-1.billing.${expiresAt}`).toString('base64url');
    const [payload] = token.split('.');
    expect(payload).toBeDefined();
    expect(verifyUnsubscribeToken(`${unknown}.${'A'.repeat(43)}`, SECRET, 0)).toBeNull();
  });
});

describe('weekStartUtc', () => {
  it('returns the Monday of the containing UTC week', () => {
    expect(weekStartUtc(new Date('2026-10-21T12:00:00.000Z'))).toBe('2026-10-19');
    expect(weekStartUtc(new Date('2026-10-19T00:00:00.000Z'))).toBe('2026-10-19');
    expect(weekStartUtc(new Date('2026-10-25T23:59:59.999Z'))).toBe('2026-10-19');
    expect(weekStartUtc(new Date('2026-01-01T00:00:00.000Z'))).toBe('2025-12-29');
  });
});
