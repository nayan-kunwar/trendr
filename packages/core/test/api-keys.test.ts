import { describe, expect, it } from 'vitest';

import { createApiKeyMaterial, hashApiKey, parseApiKey, randomBase62 } from '../src/api-keys.js';

const PEPPER = 'unit-api-key-pepper-0123456789abcdef';

describe('API key material (spec §15)', () => {
  it('generates the documented dt_live_<8>_<32> shape', () => {
    const material = createApiKeyMaterial(PEPPER);
    expect(material.raw).toMatch(/^dt_live_[A-Za-z0-9]{8}_[A-Za-z0-9]{32}$/);
    expect(material.prefix).toMatch(/^dt_live_[A-Za-z0-9]{8}$/);
    expect(material.raw.startsWith(`${material.prefix}_`)).toBe(true);
    expect(parseApiKey(material.raw)).toEqual({ prefix: material.prefix });
    expect(material.hash).toEqual(hashApiKey(PEPPER, material.raw));
  });

  it('never repeats a prefix or secret', () => {
    const first = createApiKeyMaterial(PEPPER);
    const second = createApiKeyMaterial(PEPPER);
    expect(first.prefix).not.toBe(second.prefix);
    expect(first.raw).not.toBe(second.raw);
  });

  it('rejects malformed keys', () => {
    expect(parseApiKey('')).toBeNull();
    expect(parseApiKey('dt_live_short_secret')).toBeNull();
    expect(parseApiKey('dt_test_ABCDEFGH_' + 'a'.repeat(32))).toBeNull();
  });

  it('randomBase62 returns exactly the requested length', () => {
    expect(randomBase62(0)).toBe('');
    expect(randomBase62(8)).toMatch(/^[A-Za-z0-9]{8}$/);
    expect(randomBase62(32)).toHaveLength(32);
  });
});
