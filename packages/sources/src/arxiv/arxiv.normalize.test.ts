import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { FetchedItem } from '../adapter.js';
import { parseArxivAtom } from './atom.js';
import { normalizeArxivItem, type ArxivRaw } from './normalize.js';
import { HfDailyPapersSchema, HfPaperSchema, type HfPaper } from './schemas.js';

/**
 * Spec §18 task 5.4 — pure normalization for arXiv discovery payloads and the
 * HF paper records that carry upvotes plus the linked GitHub repository.
 */

const NOW = new Date('2026-10-20T12:00:00Z');

function readText(name: string): string {
  return readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url), 'utf8');
}

function readJson(name: string): unknown {
  return JSON.parse(readText(name)) as unknown;
}

const PAGE = parseArxivAtom(readText('atom-page.xml'));
const DAILY = HfDailyPapersSchema.parse(readJson('hf-daily-papers.json'));
const PAPER = HfPaperSchema.parse(readJson('hf-paper.json'));

function fetched(raw: ArxivRaw, externalId: string): FetchedItem<ArxivRaw> {
  return {
    ref: { source: 'arxiv', kind: 'paper', externalId },
    raw,
    fetchedAt: NOW,
  };
}

describe('arXiv normalization (spec §7.3.5)', () => {
  it('maps an Atom entry to a paper with the spec topic aliases', () => {
    const entry = PAGE[0];
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const normalized = normalizeArxivItem(fetched({ kind: 'atom', entry }, entry.externalId));
    expect(normalized).not.toBeNull();
    expect(normalized?.item).toMatchObject({
      source: 'arxiv',
      kind: 'paper',
      externalId: '2610.26863',
      upstreamId: null,
      name: '2610.26863',
      displayName: 'Text-to-Image Generative Modeling Without Language Pretraining',
      url: 'https://arxiv.org/abs/2610.26863',
      primaryMetric: 'upvotes',
      isArchived: false,
    });
    expect(normalized?.item.topics).toEqual(
      expect.arrayContaining(['machine-learning', 'computer-vision']),
    );
    expect(normalized?.item.metadata).toMatchObject({
      primaryCategory: 'cs.LG',
      categories: ['cs.LG', 'cs.CV'],
      abstractUrl: 'https://arxiv.org/abs/2610.26863',
      pdfUrl: 'https://arxiv.org/pdf/2610.26863',
      comment: expect.stringContaining('27 pages') as unknown,
    });
    expect(normalized?.item.metadata.authors).toHaveLength(8);
    expect(normalized?.snapshots).toEqual([]);
    expect(normalized?.aliases).toEqual([]);
  });

  it('normalizes the recorded HF paper to an upvotes snapshot and paper_code alias', () => {
    const normalized = normalizeArxivItem(fetched({ kind: 'hf-detail', paper: PAPER }, PAPER.id));

    expect(normalized?.item).toMatchObject({
      source: 'arxiv',
      kind: 'paper',
      externalId: '2610.22471',
      displayName: 'Has GPT-6-Astra Achieved Embodied Intelligence?',
      url: 'https://arxiv.org/abs/2610.22471',
      primaryMetric: 'upvotes',
    });
    expect(normalized?.item.description?.length).toBeLessThanOrEqual(1_000);
    expect(normalized?.item.homepage).toBe(PAPER.projectPage);
    expect(normalized?.snapshots).toEqual([{ metric: 'upvotes', value: 419 }]);
    expect(normalized?.item.metadata).toMatchObject({
      hfPaperId: '2610.22471',
      githubRepo: 'https://github.com/OpenSenseNova/SenseNova-RoboRSI',
      githubStars: 151,
    });
    expect(normalized?.aliases).toEqual([
      {
        source: 'github',
        kind: 'repo',
        externalId: 'opensensenova/sensenova-roborsi',
        relation: 'paper_code',
        confidence: 0.9,
        evidence: 'hf.paper.githubRepo',
      },
    ]);
  });

  it('accepts a daily-paper entry and strips a version suffix from the HF id', () => {
    const dailyPaper = DAILY[0]?.paper;
    expect(dailyPaper).toBeDefined();
    if (dailyPaper === undefined) return;
    const versioned: HfPaper = { ...dailyPaper, id: `${dailyPaper.id}v4` };

    const normalized = normalizeArxivItem(
      fetched({ kind: 'hf-daily', paper: versioned }, '2610.22471v4'),
    );
    expect(normalized?.item.externalId).toBe('2610.22471');
    expect(normalized?.snapshots).toEqual([{ metric: 'upvotes', value: dailyPaper.upvotes }]);
  });

  it('returns null when there is no HF paper payload', () => {
    expect(
      normalizeArxivItem(fetched({ kind: 'hf-detail', paper: null }, '2610.22471')),
    ).toBeNull();
  });
});
