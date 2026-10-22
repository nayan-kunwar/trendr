import { authFetch, authFetchVoid } from './auth';
import { ApiKeysResponseSchema, CreateApiKeyResponseSchema, type ApiKey } from './api-key-schemas';

export async function listApiKeys(): Promise<ApiKey[]> {
  const body = await authFetch('/v1/me/api-keys', ApiKeysResponseSchema);
  return body.apiKeys;
}

export function createApiKey(name: string): Promise<{ apiKey: ApiKey; key: string }> {
  return authFetch('/v1/me/api-keys', CreateApiKeyResponseSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function revokeApiKey(id: string): Promise<void> {
  return authFetchVoid(`/v1/me/api-keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
