import { z } from 'zod';

/** Mirrors the API API-key wires. */

export const ApiKeySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.enum(['read', 'admin'])),
  rateLimitPerMin: z.number().int(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeysResponseSchema = z.object({ apiKeys: z.array(ApiKeySchema) });

export const CreateApiKeyResponseSchema = z.object({
  apiKey: ApiKeySchema,
  key: z.string(),
});
