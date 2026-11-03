import { randomUUID } from 'node:crypto';

import type { Redis } from 'ioredis';

import { ConflictError, NotFoundError, createApiKeyMaterial, redisKeys } from '@trendr/core';
import {
  countActiveApiKeysForUser,
  insertApiKey,
  isUniqueViolation,
  listApiKeysForUser,
  revokeApiKey,
  type ApiKeySummary,
  type Db,
} from '@trendr/db';

import type { ApiKeyBody, CreateApiKeyInput } from '../schemas/api-keys.js';

/** Spec §10.5/§15 — keys are shown once, capped at five active, revoke-only. */

const MAX_ACTIVE_KEYS = 5;

type ApiKeyScope = 'read' | 'admin';

function isScope(value: string): value is ApiKeyScope {
  return value === 'read' || value === 'admin';
}

function scopesOf(row: ApiKeySummary): ApiKeyScope[] {
  const scopes = row.scopes.filter(isScope);
  return scopes.length === 0 ? ['read'] : scopes;
}

function toDto(row: ApiKeySummary): ApiKeyBody {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    scopes: scopesOf(row),
    rateLimitPerMin: row.rateLimitPerMin,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface ApiKeyServiceDeps {
  db: Db;
  pepper: string;
  /** M-2: invalidates the API-key lookup cache on revoke. */
  redis?: Redis;
  now?: () => Date;
}

export async function listApiKeysForCurrentUser(
  deps: ApiKeyServiceDeps,
  userId: string,
): Promise<ApiKeyBody[]> {
  return (await listApiKeysForUser(deps.db, userId)).map(toDto);
}

export async function createApiKeyForCurrentUser(
  deps: ApiKeyServiceDeps,
  userId: string,
  input: CreateApiKeyInput,
): Promise<{ apiKey: ApiKeyBody; key: string }> {
  if ((await countActiveApiKeysForUser(deps.db, userId)) >= MAX_ACTIVE_KEYS) {
    throw new ConflictError(`at most ${MAX_ACTIVE_KEYS} active API keys are allowed`);
  }
  const now = deps.now?.() ?? new Date();
  const expiresAt =
    input.expiresInDays === undefined
      ? null
      : new Date(now.getTime() + input.expiresInDays * 24 * 60 * 60 * 1_000);

  const material = createApiKeyMaterial(deps.pepper);
  try {
    const row = await insertApiKey(deps.db, {
      id: randomUUID(),
      userId,
      name: input.name,
      prefix: material.prefix,
      keyHash: material.hash,
      scopes: ['read'],
      rateLimitPerMin: 120,
      expiresAt,
    });
    return { apiKey: toDto(row), key: material.raw };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError('an API key with that name already exists');
    }
    throw error;
  }
}

export async function revokeApiKeyForCurrentUser(
  deps: ApiKeyServiceDeps,
  userId: string,
  keyId: string,
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  const row = await revokeApiKey(deps.db, userId, keyId, now);
  if (row === null) throw new NotFoundError('API key not found');
  // M-2: the authentication cache must not keep a revoked key alive.
  await deps.redis?.del(redisKeys.apiKeyLookup(row.prefix)).catch(() => undefined);
}
