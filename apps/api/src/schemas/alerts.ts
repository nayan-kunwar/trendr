import { z } from 'zod';

import {
  AlertTypeSchema,
  NewAliasParamsSchema,
  RankEnteredParamsSchema,
  ThresholdCrossedParamsSchema,
  VelocitySpikeParamsSchema,
  WindowSchema,
} from '@trendr/core';

/**
 * Spec §10.1/§13.1 — alert-rule and alert-event wire schemas. `params` is a
 * JSON object on the wire; the service validates it against the rule type.
 */

export const AlertIdParam = z.object({ alertId: z.uuid() });

const itemIdString = z.string().regex(/^\d{1,19}$/);

/** Spec �10.4 � every creation body carries its type inside `params`. */
const alertParams = z.discriminatedUnion('type', [
  VelocitySpikeParamsSchema.extend({ type: z.literal('velocity_spike') }),
  RankEnteredParamsSchema.extend({ type: z.literal('rank_entered') }),
  ThresholdCrossedParamsSchema.extend({ type: z.literal('threshold_crossed') }),
  NewAliasParamsSchema.extend({ type: z.literal('new_alias') }),
]);

const createBase = {
  itemId: itemIdString.optional(),
  watchlistId: z.uuid().optional(),
  window: WindowSchema.default('24h'),
  cooldownHours: z.number().int().min(1).max(720).default(24),
};

export const CreateAlertBody = z
  .strictObject({ ...createBase, params: alertParams })
  .superRefine((value, ctx) => {
    if (value.params.type === 'rank_entered') {
      if (value.itemId !== undefined || value.watchlistId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['params', 'type'],
          message: 'rank_entered rules have no item or watchlist target',
        });
      }
      return;
    }
    const targets = Number(value.itemId !== undefined) + Number(value.watchlistId !== undefined);
    if (targets !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['itemId'],
        message: 'exactly one of itemId or watchlistId is required',
      });
    }
  });

export const UpdateAlertBody = z
  .strictObject({
    type: AlertTypeSchema.optional(),
    itemId: itemIdString.nullable().optional(),
    watchlistId: z.uuid().nullable().optional(),
    window: WindowSchema.optional(),
    params: z.record(z.string(), z.unknown()).optional(),
    cooldownHours: z.number().int().min(1).max(720).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'no fields to update' });

export const AlertDto = z.object({
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

export const AlertsResponse = z.object({ alerts: z.array(AlertDto) });

export const AlertEventDto = z.object({
  id: z.string(),
  alertId: z.uuid(),
  alertType: AlertTypeSchema,
  window: WindowSchema,
  item: z.object({
    id: z.string(),
    source: z.string(),
    displayName: z.string(),
    url: z.url(),
  }),
  payload: z.record(z.string(), z.unknown()),
  triggeredAt: z.iso.datetime(),
  deliveredAt: z.iso.datetime().nullable(),
  deliveryStatus: z.enum(['pending', 'sent', 'failed', 'suppressed']),
});

export const AlertEventsQuery = z.object({
  cursor: z
    .string()
    .regex(/^\d{1,19}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const AlertEventsResponse = z.object({
  events: z.array(AlertEventDto),
  nextCursor: z.string().nullable(),
});

export type CreateAlertInput = z.infer<typeof CreateAlertBody>;
export type UpdateAlertInput = z.infer<typeof UpdateAlertBody>;
export type AlertBody = z.infer<typeof AlertDto>;
export type AlertEventBody = z.infer<typeof AlertEventDto>;
