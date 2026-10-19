/**
 * Spec §7.1 step 5 — topic slug normalization shared by every adapter. Each
 * item keeps at most 20 topics; slugs match `^[a-z0-9][a-z0-9-]{0,49}$` and a
 * small synonym table keeps topics comparable across sources.
 */

/** Applied after slugification so `MCP-Server` and `model context protocol` fold together. */
export const TOPIC_SYNONYMS: Readonly<Record<string, string>> = {
  'mcp-server': 'mcp',
  'model-context-protocol': 'mcp',
  llms: 'llm',
};

/** Spec §7.1 step 5: "Each item keeps at most 20 topics." */
export const MAX_ITEM_TOPICS = 20;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

/** One raw topic name (GitHub topic, npm keyword, PyPI classifier, …) → slug, or null. */
export function normalizeTopicSlug(raw: string): string | null {
  const collapsed = raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (collapsed === '') return null;
  const truncated = collapsed.length > 50 ? collapsed.slice(0, 50).replace(/-+$/, '') : collapsed;
  if (truncated === '') return null;
  const slug = TOPIC_SYNONYMS[truncated] ?? truncated;
  return SLUG_PATTERN.test(slug) ? slug : null;
}

/** Slugify a topic list: drops unusable names, dedupes and applies the 20-topic cap. */
export function normalizeTopicSlugs(raws: readonly string[]): string[] {
  const slugs: string[] = [];
  for (const raw of raws) {
    const slug = normalizeTopicSlug(raw);
    if (slug === null || slugs.includes(slug)) continue;
    slugs.push(slug);
    if (slugs.length >= MAX_ITEM_TOPICS) break;
  }
  return slugs;
}
