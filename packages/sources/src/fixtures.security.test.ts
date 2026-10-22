import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Spec §16 — aggregate fixture-token audit. The per-source tests cover the
 * GitHub and npm fixtures; this scan walks every `__fixtures__` directory so a
 * newly added source cannot silently ship a credential-shaped string.
 */
const SOURCES_ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE_EXTENSIONS = new Set(['.json', '.xml', '.txt', '.html']);

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'GitHub classic PAT', pattern: /ghp_[A-Za-z0-9]/ },
  { name: 'GitHub fine-grained PAT', pattern: /github_pat_[A-Za-z0-9]/ },
  { name: 'GitHub OAuth token', pattern: /gh[ous]_[A-Za-z0-9]/ },
  { name: 'Hugging Face token', pattern: /hf_[A-Za-z0-9]{10}/ },
  { name: 'npm token', pattern: /npm_[A-Za-z0-9]{10}/ },
  { name: 'PyPI token', pattern: /pypi-AgEI[A-Za-z0-9_-]{10}/ },
  { name: 'authorization header', pattern: /["']?authorization["']?\s*[:=]\s*\S/i },
  { name: 'set-cookie header', pattern: /["']?set-cookie["']?\s*[:=]\s*\S/i },
];

async function fixtureFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && entry.name === '__fixtures__') {
      files.push(...(await walk(path)));
    } else if (entry.isDirectory()) {
      files.push(...(await fixtureFiles(path)));
    }
  }
  return files;
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else if (FIXTURE_EXTENSIONS.has(extname(entry.name))) files.push(path);
  }
  return files;
}

describe('all source fixtures (spec §16)', () => {
  it('contain no token prefixes or auth headers', async () => {
    const files = await fixtureFiles(SOURCES_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(20);
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      for (const { name, pattern } of FORBIDDEN) {
        expect(pattern.test(text), `${file} must not contain a ${name}`).toBe(false);
      }
    }
  });
});
