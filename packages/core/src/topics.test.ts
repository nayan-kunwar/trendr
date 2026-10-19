import { describe, expect, it } from 'vitest';

import { MAX_ITEM_TOPICS, normalizeTopicSlug, normalizeTopicSlugs } from './topics.js';

describe('topic slug normalization (spec §7.1 step 5)', () => {
  it('slugifies upstream topic names', () => {
    expect(normalizeTopicSlug('TypeScript')).toBe('typescript');
    expect(normalizeTopicSlug('vector search')).toBe('vector-search');
    expect(normalizeTopicSlug('C++')).toBe('c');
    expect(normalizeTopicSlug('a---b')).toBe('a-b');
    expect(normalizeTopicSlug('  Next.js  ')).toBe('next-js');
    expect(normalizeTopicSlug('écharts')).toBe('charts');
  });

  it('applies the synonym table so topics stay comparable across sources', () => {
    expect(normalizeTopicSlug('mcp-server')).toBe('mcp');
    expect(normalizeTopicSlug('model-context-protocol')).toBe('mcp');
    expect(normalizeTopicSlug('LLMs')).toBe('llm');
  });

  it('rejects names that leave nothing usable', () => {
    expect(normalizeTopicSlug('')).toBeNull();
    expect(normalizeTopicSlug('   ')).toBeNull();
    expect(normalizeTopicSlug('---')).toBeNull();
    expect(normalizeTopicSlug('...')).toBeNull();
  });

  it('truncates to the 50-character slug limit', () => {
    expect(normalizeTopicSlug('x'.repeat(80))).toBe('x'.repeat(50));
    expect(normalizeTopicSlug(`${'y'.repeat(49)}-tail`)).toBe('y'.repeat(49));
  });

  it('dedupes and keeps at most 20 topics in upstream order', () => {
    const raws = ['b', 'a', 'b', ...Array.from({ length: 30 }, (_, index) => `t-${index}`)];
    const slugs = normalizeTopicSlugs(raws);
    expect(slugs).toHaveLength(MAX_ITEM_TOPICS);
    expect(slugs.slice(0, 3)).toEqual(['b', 'a', 't-0']);
  });
});
