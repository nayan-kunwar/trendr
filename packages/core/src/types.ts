import { z } from 'zod';

/**
 * Spec §5 — runtime arrays with their Zod schemas. The remaining interfaces
 * (`Item`, `Score`, …) land with task 1.4; the schema package imports the
 * const arrays below to build the Postgres enums (spec §6.4).
 */

export const SOURCES = ['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp'] as const;
export const SourceSchema = z.enum(SOURCES);
export type Source = z.infer<typeof SourceSchema>;

export const ITEM_KINDS = [
  'repo',
  'package',
  'model',
  'dataset',
  'space',
  'paper',
  'mcp_server',
] as const;
export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const WINDOWS = ['24h', '7d', '30d'] as const;
export const WindowSchema = z.enum(WINDOWS);
export type Window = z.infer<typeof WindowSchema>;

export const TIERS = ['hot', 'warm', 'cold', 'archived'] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = z.infer<typeof TierSchema>;

export const METRICS = [
  'stars',
  'forks',
  'watchers',
  'open_issues',
  'downloads',
  'downloads_total',
  'likes',
  'upvotes',
  'trending_score',
  'comments',
] as const;
export const MetricSchema = z.enum(METRICS);
export type Metric = z.infer<typeof MetricSchema>;
