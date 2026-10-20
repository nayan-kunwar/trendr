import { z } from 'zod';

/**
 * Spec §7.3.6 — the registry list payload. The official `_meta` block carries
 * the lifecycle status; publisher-provided metadata is free-form and only its
 * keywords/categories are consumed by normalization.
 */

export const McpRepositorySchema = z
  .object({
    url: z.string().nullish(),
    source: z.string().nullish(),
  })
  .nullish();

export const McpPackageSchema = z.object({
  registryType: z.string(),
  identifier: z.string(),
  version: z.string().nullish(),
  registryBaseUrl: z.string().nullish(),
});

export const McpRemoteSchema = z.object({
  type: z.string(),
  url: z.string(),
});

export const McpServerSchema = z.object({
  $schema: z.string().nullish(),
  name: z.string().min(1),
  title: z.string().nullish(),
  description: z.string().nullish(),
  version: z.string().nullish(),
  repository: McpRepositorySchema,
  packages: z.array(McpPackageSchema).nullish(),
  remotes: z.array(McpRemoteSchema).nullish(),
  websiteUrl: z.string().nullish(),
  _meta: z.record(z.string(), z.unknown()).nullish(),
});
export type McpServer = z.infer<typeof McpServerSchema>;
export type McpPackage = z.infer<typeof McpPackageSchema>;

export const McpOfficialMetaSchema = z.object({
  status: z.string().nullish(),
  statusChangedAt: z.string().nullish(),
  publishedAt: z.string().nullish(),
  updatedAt: z.string().nullish(),
  isLatest: z.boolean().nullish(),
  statusMessage: z.string().nullish(),
});
export type McpOfficialMeta = z.infer<typeof McpOfficialMetaSchema>;

export const McpRegistryEntrySchema = z.object({
  server: McpServerSchema,
  _meta: z.object({
    'io.modelcontextprotocol.registry/official': McpOfficialMetaSchema,
  }),
});
export type McpRegistryEntry = z.infer<typeof McpRegistryEntrySchema>;

export const McpRegistryListSchema = z.object({
  servers: z.array(McpRegistryEntrySchema).nullish(),
  metadata: z
    .object({
      count: z.number().nullish(),
      nextCursor: z.string().nullish(),
    })
    .nullish(),
});
export type McpRegistryList = z.infer<typeof McpRegistryListSchema>;
