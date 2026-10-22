import { z } from 'zod';

import { LeaderboardScopeSchema, MetricSchema, WindowSchema } from './types.js';

/**
 * Spec §13.1 — alert-rule vocabulary shared by the API (validation), the web
 * form (mirrored client-side because the web cannot import server runtime
 * code) and the worker (evaluation).
 */

export const ALERT_TYPES = [
  'velocity_spike',
  'rank_entered',
  'threshold_crossed',
  'new_alias',
] as const;
export const AlertTypeSchema = z.enum(ALERT_TYPES);
export type AlertType = z.infer<typeof AlertTypeSchema>;

export const DEFAULT_ALERT_COOLDOWN_HOURS = 24;

export const VelocitySpikeParamsSchema = z.object({
  /** Spec §13.1: percentile floor. */
  minPercentile: z.number().min(50).max(100).default(95),
  /** Spec §13.1: `delta ≥ multiple × trailing average delta`. */
  minDeltaMultiple: z.number().min(1).max(100).default(3),
});
export type VelocitySpikeParams = z.infer<typeof VelocitySpikeParamsSchema>;

export const RankEnteredParamsSchema = z.object({
  topN: z.number().int().min(1).max(100).default(10),
  scope: LeaderboardScopeSchema.default('all'),
  /** Optional language filter (board key segment). */
  lang: z.string().min(1).max(40).optional(),
  /** Optional topic filter (global filter per §13.1). */
  topic: z.string().min(1).max(50).optional(),
});
export type RankEnteredParams = z.infer<typeof RankEnteredParamsSchema>;

export const ThresholdCrossedParamsSchema = z.object({
  metric: MetricSchema,
  value: z.number().int().positive(),
});
export type ThresholdCrossedParams = z.infer<typeof ThresholdCrossedParamsSchema>;

export const NewAliasParamsSchema = z.object({}).strict();
export type NewAliasParams = z.infer<typeof NewAliasParamsSchema>;

export const AlertParamsSchema = z.union([
  VelocitySpikeParamsSchema,
  RankEnteredParamsSchema,
  ThresholdCrossedParamsSchema,
  NewAliasParamsSchema,
]);
export type AlertParams = z.infer<typeof AlertParamsSchema>;

/** Parse persisted `alerts.params` for one rule type, applying spec defaults. */
export function parseAlertParams(type: AlertType, params: unknown): AlertParams {
  switch (type) {
    case 'velocity_spike':
      return VelocitySpikeParamsSchema.parse(params ?? {});
    case 'rank_entered':
      return RankEnteredParamsSchema.parse(params ?? {});
    case 'threshold_crossed':
      return ThresholdCrossedParamsSchema.parse(params ?? {});
    case 'new_alias':
      return NewAliasParamsSchema.parse(params ?? {});
  }
}

export const AlertWindowSchema = WindowSchema;
