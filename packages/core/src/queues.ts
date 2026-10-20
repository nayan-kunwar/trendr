import { z } from 'zod';

import { SourceSchema, TierSchema, WindowSchema } from './types.js';

/**
 * Spec §5.2 — BullMQ queue names and payload schemas. Queue names must not
 * contain ':' (BullMQ restriction); job ids must be deterministic so BullMQ
 * dedupes identical work.
 */

export const QUEUE = {
  ingest: {
    github: 'ingest-github',
    npm: 'ingest-npm',
    pypi: 'ingest-pypi',
    huggingface: 'ingest-huggingface',
    arxiv: 'ingest-arxiv',
    mcp: 'ingest-mcp',
  },
  scoring: 'scoring',
  notify: 'notify',
  digest: 'digest',
  maintenance: 'maintenance',
  deadLetter: 'dead-letter',
} as const; // BullMQ queue names must not contain ':'

/** §7.2 schedule vs. operator-triggered: only scheduled jobs may skip (§7.5). */
export const IngestTriggerSchema = z.enum(['schedule', 'manual']);

export const IngestJobSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('discover'),
    source: SourceSchema,
    strategy: z.string(),
    maxItems: z.number().int().positive(),
    trigger: IngestTriggerSchema.optional(),
  }),
  z.object({
    type: z.literal('snapshot-fanout'),
    source: SourceSchema,
    tier: TierSchema,
    trigger: IngestTriggerSchema.optional(),
  }),
  z.object({
    type: z.literal('snapshot'),
    source: SourceSchema,
    tier: TierSchema,
    batch: z.number().int().nonnegative(),
    batchCount: z.number().int().positive(),
    trigger: IngestTriggerSchema.optional(),
  }),
  z.object({
    type: z.literal('daily'),
    source: SourceSchema,
    /**
     * Additive relaxation of the §5.2 shape: BullMQ `upsertJobScheduler`
     * templates are static, so a per-tick UTC day cannot be supplied. The
     * scheduled job omits it; adapters anchor the window on `ctx.now()`.
     * Manual/backfill-style jobs may still carry the day for reproducibility.
     */
    day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    trigger: IngestTriggerSchema.optional(),
  }),
  z.object({
    type: z.literal('backfill'),
    source: SourceSchema,
    itemId: z.string(),
    days: z.number().int().min(1).max(365),
    trigger: IngestTriggerSchema.optional(),
  }),
  z.object({
    type: z.literal('refresh-item'),
    source: SourceSchema,
    itemId: z.string(),
    trigger: IngestTriggerSchema.optional(),
  }),
]);
export type IngestJob = z.infer<typeof IngestJobSchema>;

export const ScoringJobSchema = z.object({
  source: SourceSchema,
  windows: z.array(WindowSchema).default(['24h', '7d', '30d']),
  trigger: z.enum(['schedule', 'ingest', 'admin']),
});
export type ScoringJob = z.infer<typeof ScoringJobSchema>;

export const NotifyJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('evaluate-alerts'), scoreRunId: z.string(), source: SourceSchema }),
  z.object({ type: z.literal('send-alert-email'), alertEventId: z.string() }),
]);
export type NotifyJob = z.infer<typeof NotifyJobSchema>;

export const DigestJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('build-weekly-digest'), weekStart: z.string() }),
  z.object({ type: z.literal('send-digest'), subscriptionId: z.string(), weekStart: z.string() }),
]);
export type DigestJob = z.infer<typeof DigestJobSchema>;

export const MaintenanceJobSchema = z.object({
  type: z.enum([
    'create-partitions',
    'retention',
    'retier-items',
    'rollup-daily',
    'cleanup-tokens',
  ]),
});
export type MaintenanceJob = z.infer<typeof MaintenanceJobSchema>;

/**
 * Spec §5.2 — 'YYYY-MM-DDTHH-mm' (UTC), floored to ten minutes. Scoring runs
 * requested inside one slot dedupe into a single BullMQ job; the admin ingest
 * endpoint reuses the same slot for its manual triggers.
 */
export function scoringSlot(at: Date): string {
  const minutes = Math.floor(at.getUTCMinutes() / 10) * 10;
  const date = at.toISOString().slice(0, 10);
  const hours = String(at.getUTCHours()).padStart(2, '0');
  return `${date}T${hours}-${String(minutes).padStart(2, '0')}`;
}

/**
 * Spec §7.7 — the `dead-letter` payload parked by the worker and replayed by
 * the admin API (spec §10.1 `POST /v1/admin/dlq/:jobId/retry`).
 */
export const DeadLetterJobSchema = z.object({
  originalQueue: z.string(),
  name: z.string(),
  data: z.unknown(),
  jobId: z.string().optional(),
  failedReason: z.string(),
  stack: z.string().optional(),
  attemptsMade: z.number().int(),
  failedAt: z.string(),
});
export type DeadLetterJob = z.infer<typeof DeadLetterJobSchema>;

/**
 * Spec §7.5 — default BullMQ job options shared by every producer (worker and
 * the admin API): 5 attempts with the custom backoff registered per worker,
 * bounded completed retention and failed jobs kept for §7.7 triage.
 */
export const DEFAULT_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'custom' },
  removeOnComplete: { age: 24 * 3600, count: 2000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

/** Deterministic jobIds → BullMQ dedupes identical jobs (idempotency key). */
export const jobId = {
  snapshot: (s: string, tier: string, hourIso: string, batch: number) =>
    `${s}.snapshot.${tier}.${hourIso}.${batch}`,
  /** Admin `/v1/admin/ingest {type:'snapshot'}` (§10.1): the §7.2 fan-out row for a tier. */
  snapshotFanout: (s: string, tier: string, slot: string) => `${s}.snapshot-fanout.${tier}.${slot}`,
  daily: (s: string, day: string) => `${s}.daily.${day}`,
  discover: (s: string, strategy: string, slot: string) => `${s}.discover.${strategy}.${slot}`,
  backfill: (s: string, itemId: string, day: string) => `backfill.${s}.${itemId}.${day}`,
  /** Watchlist instant promotion (§7.8): one refresh per item per UTC day. */
  refreshItem: (s: string, itemId: string, day: string) => `refresh.${s}.${itemId}.${day}`,
  scoring: (s: string, slot: string) => `score.${s}.${slot}`, // slot = 10-min bucket
  sendDigest: (subId: string, week: string) => `digest.${subId}.${week}`,
  alertEmail: (eventId: string) => `alert.${eventId}`,
  evaluateAlerts: (scoreRunId: string) => `alerts.${scoreRunId}`,
};
// hourIso format is 'YYYY-MM-DDTHH' (UTC, no colons); slot for scoring = 'YYYY-MM-DDTHH-mm' floored to 10 min.
