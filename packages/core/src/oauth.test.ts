import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createOAuthState, createPkcePair, oauthStateHash, sanitizeReturnTo } from './oauth.js';

describe('OAuth PKCE and state primitives', () => {
  it('creates a 43-character verifier and its S256 challenge', () => {
    const pair = createPkcePair();
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats a verifier or state', () => {
    const pairs = new Set(Array.from({ length: 20 }, () => createPkcePair().verifier));
    expect(pairs.size).toBe(20);
    const states = new Set(Array.from({ length: 20 }, () => createOAuthState()));
    expect(states.size).toBe(20);
  });

  it('hashes state for Redis without storing the raw value', () => {
    const state = createOAuthState();
    const hash = oauthStateHash(state);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain(state);
  });
});

describe('returnTo sanitisation', () => {
  it('accepts same-origin absolute paths', () => {
    expect(sanitizeReturnTo('/dashboard')).toBe('/dashboard');
    expect(sanitizeReturnTo('/items/42?tab=scores#top')).toBe('/items/42?tab=scores#top');
  });

  it.each([
    'https://evil.example',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'dashboard',
    '',
    '/dashboard\nlocation: https://evil.example',
    `/${'a'.repeat(600)}`,
    null,
    undefined,
    42,
  ])('rejects %s', (value) => {
    expect(sanitizeReturnTo(value)).toBe('/dashboard');
  });
});
