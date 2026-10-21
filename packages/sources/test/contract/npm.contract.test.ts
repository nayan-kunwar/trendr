import { describe, expect, it } from 'vitest';

import {
  bulkRangeUrl,
  lastDayPointUrl,
  npmDailyWindow,
  packumentUrl,
  searchUrl,
  singleRangeUrl,
} from '../../src/npm/downloads.js';
import {
  NpmBulkDownloadsSchema,
  NpmDownloadsRangeSchema,
  NpmPackumentSchema,
  NpmPointSchema,
  NpmSearchResponseSchema,
} from '../../src/npm/schemas.js';
import { CONTRACT_ENABLED, contractFetch, contractJson } from './helpers.js';

const describeContract = describe.skipIf(!CONTRACT_ENABLED);

describeContract('npm upstream contract (spec §7.3.2)', () => {
  it('validates search and packument payloads', async () => {
    const search = await contractFetch(searchUrl('mcp', 0));
    const searchBody = NpmSearchResponseSchema.parse(contractJson(search.text));
    expect(searchBody.objects.length).toBeGreaterThan(0);

    const packument = await contractFetch(packumentUrl('react'));
    const packumentBody = NpmPackumentSchema.parse(contractJson(packument.text));
    expect(packumentBody.name).toBe('react');
  });

  it('validates the point, single-range and bulk-downloads payloads', async () => {
    const point = await contractFetch(lastDayPointUrl('react'));
    const pointBody = NpmPointSchema.parse(contractJson(point.text));
    expect(pointBody.downloads).toBeGreaterThanOrEqual(0);

    const window = npmDailyWindow(new Date());
    const single = await contractFetch(singleRangeUrl(window.start, window.end, 'react'));
    const singleBody = NpmDownloadsRangeSchema.parse(contractJson(single.text));
    expect(singleBody.downloads.length).toBeGreaterThan(0);

    const bulk = await contractFetch(bulkRangeUrl(window.start, window.end, ['react', 'lodash']));
    const bulkBody = NpmBulkDownloadsSchema.parse(contractJson(bulk.text));
    expect(Object.keys(bulkBody)).toEqual(expect.arrayContaining(['react', 'lodash']));
  });
});
