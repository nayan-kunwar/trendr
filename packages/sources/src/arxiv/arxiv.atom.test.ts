import { readFileSync } from 'node:fs';

import { UpstreamError } from '@trendr/core';
import { describe, expect, it } from 'vitest';

import { parseArxivAtom } from './atom.js';

/**
 * Spec §18 task 5.4 — Atom fixture: multi-category entries, version stripping
 * and the API's single-entry error feed (which must never become an item).
 */

function read(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
}

const PAGE_XML = read('atom-page.xml');
const ERROR_XML = read('atom-error.xml');

describe('arXiv Atom parsing (spec §7.3.5)', () => {
  it('parses the recorded page and strips versions from canonical ids', () => {
    const entries = parseArxivAtom(PAGE_XML);

    expect(entries.map((entry) => entry.externalId)).toEqual([
      '2610.26863',
      '2610.26860',
      '2610.26861',
    ]);
    expect(entries[0]?.title).toBe(
      'Text-to-Image Generative Modeling Without Language Pretraining',
    );
    expect(entries[0]?.abstractUrl).toBe('https://arxiv.org/abs/2610.26863');
    expect(entries[0]?.pdfUrl).toBe('https://arxiv.org/pdf/2610.26863');
    expect(entries[0]?.authors).toContain('Keshigeyan Chandrasegaran');
    expect(entries[0]?.comment).toContain('27 pages');
    expect(entries[0]?.publishedAt?.toISOString()).toBe('2026-10-19T17:59:59.000Z');
  });

  it('keeps every category, with the primary category first', () => {
    const entries = parseArxivAtom(PAGE_XML);
    const multi = entries.find((entry) => entry.externalId === '2610.26860');

    expect(multi?.primaryCategory).toBe('cs.CL');
    expect(multi?.categories).toEqual(['cs.CL', 'cs.AI', 'cs.CV', 'cs.LG', 'cs.MM']);
  });

  it('deduplicates multiple versions of the same paper', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
        <entry>
          <id>http://arxiv.org/abs/2610.21185v1</id>
          <title>Version one</title>
          <published>2026-10-19T00:00:00Z</published>
        </entry>
        <entry>
          <id>http://arxiv.org/abs/2610.21185v3</id>
          <title>Version three</title>
          <published>2026-10-19T00:00:00Z</published>
        </entry>
      </feed>`;

    const entries = parseArxivAtom(xml);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.externalId).toBe('2610.21185');
    expect(entries[0]?.title).toBe('Version one');
  });

  it('throws a non-retryable error for the Atom error feed', () => {
    let thrown: unknown;
    try {
      parseArxivAtom(ERROR_XML);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UpstreamError);
    expect(thrown).toMatchObject({
      source: 'arxiv',
      retryable: false,
      message: 'arXiv API error feed: start must be non-negative',
    });
  });

  it('returns [] for an empty result page', () => {
    const xml = `<?xml version="1.0"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <title>arXiv Query</title>
      </feed>`;
    expect(parseArxivAtom(xml)).toEqual([]);
  });
});
