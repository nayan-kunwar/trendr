import { z } from 'zod';

/** Mirrors the API alert wire schemas (no server-only core imports). */

export const AlertTypeSchema = z.enum([
  'velocity_spike',
  'rank_entered',
  'threshold_crossed',
  'new_alias',
]);
export type AlertType = z.infer<typeof AlertTypeSchema>;

export const SourceSchema = z.enum(['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp']);
export type Source = z.infer<typeof SourceSchema>;

export const WindowSchema = z.enum(['24h', '7d', '30d']);
export type Window = z.infer<typeof WindowSchema>;

export const AlertSchema = z.object({
  id: z.uuid(),
  type: AlertTypeSchema,
  itemId: z.string().nullable(),
  watchlistId: z.uuid().nullable(),
  window: WindowSchema,
  params: z.record(z.string(), z.unknown()),
  cooldownHours: z.number().int(),
  enabled: z.boolean(),
  lastTriggeredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const AlertsResponseSchema = z.object({ alerts: z.array(AlertSchema) });

export const AlertEventSchema = z.object({
  id: z.string(),
  alertId: z.uuid(),
  alertType: AlertTypeSchema,
  window: WindowSchema,
  item: z.object({
    id: z.string(),
    source: SourceSchema,
    displayName: z.string(),
    url: z.url(),
  }),
  payload: z.record(z.string(), z.unknown()),
  triggeredAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  deliveryStatus: z.enum(['pending', 'sent', 'failed', 'suppressed']),
});
export type AlertEvent = z.infer<typeof AlertEventSchema>;

export const AlertEventsResponseSchema = z.object({
  events: z.array(AlertEventSchema),
  nextCursor: z.string().nullable(),
});
