import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Spec §16 — no fixture may contain a token prefix or an auth header. npm
 * needs no credentials, but packument READMEs are upstream text and could
 * embed anything, so the same scan applies. The meta evidence pins the two
 * API behaviours the adapter relies on: `last-day` is the window end, and the
 * bulk endpoint rejects scoped names.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'ghp_ classic PAT', pattern: /ghp_[A-Za-z0-9]/ },
  { name: 'github_pat_ fine-grained PAT', pattern: /github_pat_[A-Za-z0-9]/ },
  { name: 'hf_ token', pattern: /hf_[A-Za-z0-9]{10}/ },
  { name: 'npm_ token', pattern: /npm_[A-Za-z0-9]{10}/ },
  { name: 'authorization header', pattern: /authorization/i },
  { name: 'set-cookie header', pattern: /set-cookie/i },
];

describe('npm fixtures (spec §16)', () => {
  it('are JSON files with no tokens or auth headers', async () => {
    const files = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const file of files) {
      const text = await readFile(join(FIXTURES_DIR, file), 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        expect(pattern.test(text), `${file} contains ${name}`).toBe(false);
      }
    }
  });

  it('record the last-day watermark and the scoped bulk rejection', async () => {
    const meta = JSON.parse(await readFile(join(FIXTURES_DIR, 'meta.json'), 'utf8')) as {
      window: { start: string; end: string; days: string[] };
      lastDay: { start: string; end: string };
      scopedBulk: { status: number; body: string };
      search: { repository?: string | null };
      scopedPackage: string;
    };
    expect(meta.lastDay.start).toBe(meta.lastDay.end);
    expect(meta.window.end).toBe(meta.lastDay.end);
    expect(meta.window.days).toHaveLength(3);
    expect(meta.scopedBulk.status).toBe(400);
    expect(meta.scopedBulk.body).toContain('scoped packages');
    expect(meta.search.repository).toContain('github.com/');
    expect(meta.scopedPackage.startsWith('@')).toBe(true);
  });
});
