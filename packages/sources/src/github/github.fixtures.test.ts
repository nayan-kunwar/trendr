import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Spec §16: "A test asserts that no fixture contains `ghp_`, `github_pat_` or
 * `hf_` strings" — plus the other GitHub token prefixes and the auth headers
 * the recorder must strip.
 */

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

const FORBIDDEN: { name: string; pattern: RegExp }[] = [
  { name: 'ghp_ classic PAT', pattern: /ghp_[A-Za-z0-9]/ },
  { name: 'github_pat_ fine-grained PAT', pattern: /github_pat_[A-Za-z0-9]/ },
  { name: 'hf_ token', pattern: /hf_[A-Za-z0-9]{10}/ },
  { name: 'gho_ oauth token', pattern: /gho_[A-Za-z0-9]/ },
  { name: 'ghs_ app token', pattern: /ghs_[A-Za-z0-9]/ },
  { name: 'ghu_ user token', pattern: /ghu_[A-Za-z0-9]/ },
  { name: 'authorization header', pattern: /authorization/i },
  { name: 'set-cookie header', pattern: /set-cookie/i },
];

describe('github fixtures (spec §16)', () => {
  it('are valid JSON and contain no tokens or auth headers', async () => {
    const names = (await readdir(FIXTURES_DIR)).filter((name) => name.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(7);
    for (const name of names) {
      const text = await readFile(join(FIXTURES_DIR, name), 'utf8');
      expect(() => {
        JSON.parse(text);
      }, `${name} is valid JSON`).not.toThrow();
      for (const { name: label, pattern } of FORBIDDEN) {
        expect(pattern.test(text), `${name} must not contain a ${label}`).toBe(false);
      }
    }
  });
});
