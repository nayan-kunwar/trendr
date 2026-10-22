import { z } from 'zod';

/** Spec §10.1/§10.5 — per-user API key management wires. */

export const API_KEY_SCOPES = ['read', 'admin'] as const;
export const ApiKeyScopeSchema = z.enum(API_KEY_SCOPES);

export const ApiKeyDto = z.object({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(ApiKeyScopeSchema),
  rateLimitPerMin: z.number().int(),
  lastUsedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

export const ApiKeysResponse = z.object({ apiKeys: z.array(ApiKeyDto) });

export const CreateApiKeyBody = z.object({
  name: z.string().trim().min(1).max(60),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});

export const CreateApiKeyResponse = z.object({
  apiKey: ApiKeyDto,
  /** Full `dt_live_…` key; returned exactly once. */
  key: z.string(),
});

export const ApiKeyIdParam = z.object({ keyId: z.uuid() });

export type ApiKeyBody = z.infer<typeof ApiKeyDto>;
export type CreateApiKeyInput = z.infer<typeof CreateApiKeyBody>;
