import { XMLParser } from 'fast-xml-parser';
import { z } from 'zod';

import { UpstreamError } from '@trendr/core';

/**
 * Spec §7.3.3 — PyPI's discovery feeds are RSS 2.0 XML. fast-xml-parser turns
 * a one-item channel into an object and a multi-item channel into an array, so
 * the schema accepts both and the parser normalizes to an array.
 */

const RssItemSchema = z.object({
  title: z.string(),
  link: z.string(),
  description: z.string().optional(),
  pubDate: z.string().optional(),
});

const RssFeedSchema = z.object({
  rss: z.object({
    channel: z.object({
      item: z.union([RssItemSchema, z.array(RssItemSchema)]).optional(),
    }),
  }),
});

export type PypiRssItem = z.infer<typeof RssItemSchema>;

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

/** Parse either PyPI RSS feed; a schema change fails the job (no silent zero). */
export function parsePypiRss(xml: string): PypiRssItem[] {
  let parsed: unknown;
  try {
    parsed = parser.parse(xml) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new UpstreamError(`invalid PyPI RSS XML: ${detail}`, 'pypi', null, null, false);
  }
  const result = RssFeedSchema.safeParse(parsed);
  if (!result.success) {
    throw new UpstreamError(
      `PyPI RSS schema mismatch: ${result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ')}`,
      'pypi',
      null,
      null,
      false,
    );
  }
  const raw = result.data.rss.channel.item;
  const items = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return items
    .map((item) => ({
      ...item,
      title: item.title.trim(),
      link: item.link.trim(),
      ...(item.description === undefined ? {} : { description: item.description.trim() }),
    }))
    .filter((item) => item.title !== '' && item.link !== '');
}
