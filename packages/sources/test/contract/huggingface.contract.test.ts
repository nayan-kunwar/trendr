import { describe, expect, it } from 'vitest';

import { HfRepoListSchema, HfRepoSchema } from '../../src/huggingface/schemas.js';
import { hfDetailUrl, hfListUrl } from '../../src/huggingface/urls.js';
import { CONTRACT_ENABLED, contractFetch, contractJson, HF_TOKEN } from './helpers.js';

const MODEL = 'google-bert/bert-base-uncased';

const describeContract = describe.skipIf(!CONTRACT_ENABLED);

describeContract('Hugging Face upstream contract (spec §7.3.4)', () => {
  it('validates the model, dataset and space list payloads', async () => {
    for (const kind of ['model', 'dataset', 'space'] as const) {
      const response = await contractFetch(hfListUrl(kind, 'trendingScore', 1), {
        token: HF_TOKEN,
      });
      const body = HfRepoListSchema.parse(contractJson(response.text));
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]?.id).toBeTypeOf('string');
    }
  });

  it('validates the model detail payload', async () => {
    const response = await contractFetch(hfDetailUrl('model', MODEL), { token: HF_TOKEN });
    const body = HfRepoSchema.parse(contractJson(response.text));
    expect(body.id).toBe(MODEL);
  });
});
