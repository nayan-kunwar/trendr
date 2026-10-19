import { describe, expect, it } from 'vitest';

import type { SourceAdapter } from './adapter.js';
import {
  AdapterNotRegisteredError,
  getAdapter,
  listAdapters,
  registerAdapter,
} from './registry.js';

function fakeAdapter(source: 'github' | 'npm'): SourceAdapter {
  return {
    source,
    kinds: ['repo'],
    batchSize: 1,
    async *discover() {
      await Promise.resolve();
      yield [];
    },
    fetchMetrics: () => Promise.resolve([]),
    normalize: () => null,
  };
}

describe('adapter registry (spec §5.1/§7.1)', () => {
  it('throws AdapterNotRegisteredError for a source without an adapter', () => {
    expect(() => getAdapter('mcp')).toThrow(AdapterNotRegisteredError);
    expect(() => getAdapter('mcp')).toThrow('no adapter registered for source "mcp"');
  });

  it('resolves a registered adapter and lists its source', () => {
    const adapter = fakeAdapter('github');
    registerAdapter(adapter);

    expect(getAdapter('github')).toBe(adapter);
    expect(listAdapters()).toContain('github');
  });

  it('replaces the adapter when registered again (idempotent boot)', () => {
    registerAdapter(fakeAdapter('npm'));
    const replacement = fakeAdapter('npm');
    registerAdapter(replacement);

    expect(getAdapter('npm')).toBe(replacement);
  });
});
