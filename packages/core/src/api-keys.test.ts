import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { apiKeyHashesMatch, hashApiKey, parseApiKey } from './api-keys.js';

const SECRET = 'abcdef0123456789abcdef0123456789';

describe('parseApiKey (spec §10.5)', () => {
  it('accepts dt_live_<8 base62>_<32 base62>', () => {
    expect(parseApiKey(`dt_live_seedkey1_${SECRET}`)).toEqual({
      prefix: 'dt_live_seedkey1',
    });
    expect(parseApiKey(`dt_live_IT12aB34_${SECRET}`)).toEqual({
      prefix: 'dt_live_IT12aB34',
    });
  });

  it('rejects malformed keys', () => {
    const cases = [
      '',
      'dt_live_seedkey1',
      `dt_live_seedkey1_${SECRET}x`,
      `dt_live_seedkey1_${SECRET.slice(1)}`,
      `dt_live_seedkey_${SECRET}`,
      `dt_live_seedkey12_${SECRET}`,
      `dt_live_seedkey1_${SECRET.replace('a', '-')}`,
      `DT_LIVE_seedkey1_${SECRET}`,
      `dt_live_seedkey1_${SECRET}_`,
      `dt_live__${SECRET}`,
      ` dt_live_seedkey1_${SECRET}`,
    ];
    for (const raw of cases) {
      expect(parseApiKey(raw), raw).toBeNull();
    }
  });
});

describe('hashApiKey / apiKeyHashesMatch (spec §15)', () => {
  const pepper = 'pepper-0123456789abcdefghijklmnopqrstuvwxyz';
  const raw = `dt_live_seedkey1_${SECRET}`;

  it('computes HMAC-SHA256(pepper, full key)', () => {
    const expected = createHmac('sha256', pepper).update(raw).digest();
    const hash = hashApiKey(pepper, raw);
    expect(hash).toEqual(expected);
    expect(hash).toHaveLength(32);
  });

  it('is deterministic and pepper-sensitive', () => {
    expect(hashApiKey('a'.repeat(32), raw)).toEqual(hashApiKey('a'.repeat(32), raw));
    expect(hashApiKey('a'.repeat(32), raw)).not.toEqual(hashApiKey('b'.repeat(32), raw));
  });

  it('compares in constant time and never throws on length mismatch', () => {
    const hash = hashApiKey('a'.repeat(32), raw);
    expect(apiKeyHashesMatch(hash, Buffer.from(hash))).toBe(true);

    const tampered = Buffer.from(hash);
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(apiKeyHashesMatch(hash, tampered)).toBe(false);
    expect(apiKeyHashesMatch(hash, Buffer.from([1, 2, 3]))).toBe(false);
  });
});
