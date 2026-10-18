import { z } from 'zod';

/**
 * Spec §10.2 — shared wire schemas: route params, opaque cursors, page
 * metadata and the RFC 7807 problem shape.
 */

export const IdParam = z.object({ id: z.string().regex(/^\d{1,19}$/) });

/** Opaque cursor = base64url(JSON). Encodes the run id so pages stay consistent across scoring runs. */
export const LeaderboardCursor = z.object({ r: z.string(), s: z.number(), i: z.string() }); // runId, score, itemId
export const KeysetCursor = z.object({ k: z.union([z.string(), z.number()]), i: z.string() });

export const encodeCursor = (c: unknown): string =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

export const decodeCursor = <T>(raw: string, schema: z.ZodType<T>): T =>
  schema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));

export const PageMeta = z.object({ nextCursor: z.string().nullable(), limit: z.number().int() });

/** RFC 7807 problem details. */
export const Problem = z.object({
  type: z.url(), // https://trendr.dev/problems/{type}
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string(), // request path
  requestId: z.string(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});
