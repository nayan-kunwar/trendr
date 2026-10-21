import { describe, expect, it } from 'vitest';

import { parsePypiRss } from '../../src/pypi/rss.js';
import {
  PypiProjectSchema,
  PypiStatsOverallSchema,
  PypiStatsRecentSchema,
} from '../../src/pypi/schemas.js';
import {
  overallStatsUrl,
  projectJsonUrl,
  PYPI_FEEDS,
  recentStatsUrl,
} from '../../src/pypi/urls.js';
import { CONTRACT_ENABLED, contractFetch, contractJson } from './helpers.js';

const RSS_ACCEPT = 'application/rss+xml, application/xml;q=0.9';

const describeContract = describe.skipIf(!CONTRACT_ENABLED);

describeContract('PyPI upstream contract (spec §7.3.3)', () => {
  it('validates both RSS discovery feeds', async () => {
    for (const feed of [PYPI_FEEDS.newest, PYPI_FEEDS.updates]) {
      const response = await contractFetch(feed, { accept: RSS_ACCEPT });
      const items = parsePypiRss(response.text);
      expect(items.length).toBeGreaterThan(0);
      expect(items[0]?.link).toMatch(/^https:\/\/pypi\.org\/project\//);
    }
  });

  it('validates project JSON, overall downloads and recent downloads', async () => {
    const project = await contractFetch(projectJsonUrl('mcp'));
    const projectBody = PypiProjectSchema.parse(contractJson(project.text));
    expect(projectBody.info.name.toLowerCase()).toBe('mcp');

    const overall = await contractFetch(overallStatsUrl('mcp'));
    const overallBody = PypiStatsOverallSchema.parse(contractJson(overall.text));
    expect(overallBody.data.length).toBeGreaterThan(0);

    const recent = await contractFetch(recentStatsUrl('mcp'));
    const recentBody = PypiStatsRecentSchema.parse(contractJson(recent.text));
    expect(recentBody.data.last_month).toBeGreaterThanOrEqual(0);
  });
});
