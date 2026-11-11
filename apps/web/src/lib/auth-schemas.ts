import { z } from 'zod';

/** Mirrors the API's auth DTOs without pulling server-only core runtime into the bundle. */

export const AuthUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(['user', 'admin']),
  emailVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});

export const AuthSessionSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int().positive(),
  user: AuthUserSchema,
});

export const AuthMessageSchema = z.object({ ok: z.literal(true) });

export const OAuthProviderSchema = z.object({
  id: z.enum(['google', 'github']),
  label: z.string(),
});

export const OAuthProvidersSchema = z.object({
  providers: z.array(OAuthProviderSchema),
});

export type AuthUser = z.infer<typeof AuthUserSchema>;
export type AuthSession = z.infer<typeof AuthSessionSchema>;
export type OAuthProviderInfo = z.infer<typeof OAuthProviderSchema>;
