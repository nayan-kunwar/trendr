import type { Source } from '@trendr/core';

import type { SourceAdapter } from './adapter.js';

/** Thrown by `getAdapter` when the deployment has no adapter for a source. */
export class AdapterNotRegisteredError extends Error {
  readonly source: Source;

  constructor(source: Source) {
    super(`no adapter registered for source "${source}"`);
    this.name = 'AdapterNotRegisteredError';
    this.source = source;
  }
}

const registry = new Map<Source, SourceAdapter>();

/** Register (or replace) the adapter for its own `source` — idempotent on boot. */
export function registerAdapter<TRaw>(adapter: SourceAdapter<TRaw>): void {
  registry.set(adapter.source, adapter);
}

/** Spec §7.1 step 3 — resolve the adapter that runs a source's jobs. */
export function getAdapter(source: Source): SourceAdapter {
  const adapter = registry.get(source);
  if (adapter === undefined) {
    throw new AdapterNotRegisteredError(source);
  }
  return adapter;
}

/** Sources that currently have an adapter — used by ops tooling and tests. */
export function listAdapters(): Source[] {
  return [...registry.keys()];
}
