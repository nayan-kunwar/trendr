import { parseArgs } from 'node:util';

import { SOURCES, WINDOWS, type Source, type Window } from '@trendr/core';

/**
 * `pnpm worker:score --source github [--windows 24h,7d]` — argv parsing for the
 * admin-less trigger of spec §18 task 2.6. Kept free of config/Redis imports
 * (unit-testable); `score-cli.ts` wires it to the environment.
 */

export interface ScoreCliOptions {
  source: Source;
  windows: Window[];
}

export function parseScoreArgs(argv: readonly string[]): ScoreCliOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      source: { type: 'string' },
      windows: { type: 'string' },
    },
  });

  const source = values.source;
  if (source === undefined) {
    throw new Error('--source is required');
  }
  if (!isSource(source)) {
    throw new Error(`unknown source "${source}" (expected: ${SOURCES.join(', ')})`);
  }

  const requested = values.windows === undefined ? WINDOWS : values.windows.split(',');
  const windows: Window[] = [];
  for (const candidate of requested) {
    const window = candidate.trim();
    if (window.length === 0) {
      continue;
    }
    if (!isWindow(window)) {
      throw new Error(`unknown window "${window}" (expected: ${WINDOWS.join(', ')})`);
    }
    if (!windows.includes(window)) {
      windows.push(window);
    }
  }
  if (windows.length === 0) {
    throw new Error('--windows needs at least one window');
  }
  return { source, windows };
}

function isSource(value: string): value is Source {
  return (SOURCES as readonly string[]).includes(value);
}

function isWindow(value: string): value is Window {
  return (WINDOWS as readonly string[]).includes(value);
}
