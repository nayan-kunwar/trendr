import { z } from 'zod';

/**
 * Spec §10.5 — email magic links, rotating refresh tokens, and the
 * authenticated profile surface. All auth responses are private/no-store.
 */

export const MagicLinkBody = z.strictObject({
  email: z.email().max(320),
});

export const VerifyMagicLinkBody = z.strictObject({
  token: z.string().min(16).max(512),
});

export const AuthUserDto = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  role: z.enum(['user', 'admin']),
  emailVerifiedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  lastLoginAt: z.iso.datetime().nullable(),
});

export const AuthSessionResponse = z.object({
  accessToken: z.string(),
  /** Access-token lifetime in seconds (spec §10.5: 900). */
  expiresIn: z.number().int().positive(),
  user: AuthUserDto,
});

export const AuthMessageResponse = z.object({
  ok: z.literal(true),
});

export const MeResponse = AuthUserDto;

export const MePatchBody = z.strictObject({
  /** `null` clears the display name; omitted leaves it unchanged. */
  displayName: z.string().trim().min(1).max(80).nullable().optional(),
});

export type MagicLinkBodyInput = z.infer<typeof MagicLinkBody>;
export type AuthSessionBody = z.infer<typeof AuthSessionResponse>;
export type MeBody = z.infer<typeof MeResponse>;
