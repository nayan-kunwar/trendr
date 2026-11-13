import { describe, expect, it } from 'vitest';

import { assertSeedAllowed } from '../../src/seed.js';

/**
 * The seed creates a dev admin API key and fixture rows. A production database
 * must require an explicit opt-in, otherwise an operator running the documented
 * command could introduce a known privileged credential.
 */
describe('seed production guard', () => {
  it('refuses production by default', () => {
    expect(() => {
      assertSeedAllowed('production');
    }).toThrow(/disabled in production/);
  });

  it('allows development, test and an explicit production opt-in', () => {
    expect(() => {
      assertSeedAllowed('development');
    }).not.toThrow();
    expect(() => {
      assertSeedAllowed('test');
    }).not.toThrow();
    expect(() => {
      assertSeedAllowed(undefined);
    }).not.toThrow();
    expect(() => {
      assertSeedAllowed('production', true);
    }).not.toThrow();
  });
});
