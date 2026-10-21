import { describe, expect, it } from 'vitest';

import { parseArxivAtom } from '../../src/arxiv/atom.js';
import { HfDailyPapersSchema, HfPaperSchema } from '../../src/arxiv/schemas.js';
import { arxivQueryUrl, hfDailyPapersUrl, hfPaperUrl, utcDay } from '../../src/arxiv/urls.js';
import { CONTRACT_ENABLED, contractFetch, contractJson, HF_TOKEN } from './helpers.js';

const ATOM_ACCEPT = 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8';
const KNOWN_PAPER = '1706.03762';

const describeContract = describe.skipIf(!CONTRACT_ENABLED);

describeContract('arXiv upstream contract (spec §7.3.5)', () => {
  it('validates the Atom export query and normalizes at least one entry', async () => {
    const response = await contractFetch(arxivQueryUrl(0, 1), { accept: ATOM_ACCEPT });
    const entries = parseArxivAtom(response.text);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.externalId).not.toBe('');
  });

  it('validates the HF daily-paper feed and paper detail payloads', async () => {
    const daily = await contractFetch(hfDailyPapersUrl(utcDay(new Date()), 2), {
      token: HF_TOKEN,
    });
    const dailyBody = HfDailyPapersSchema.parse(contractJson(daily.text));
    expect(Array.isArray(dailyBody)).toBe(true);

    const paper = await contractFetch(hfPaperUrl(KNOWN_PAPER), { token: HF_TOKEN });
    const paperBody = HfPaperSchema.parse(contractJson(paper.text));
    expect(paperBody.id).toContain(KNOWN_PAPER);
  });
});
