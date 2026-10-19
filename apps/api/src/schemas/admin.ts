import { z } from 'zod';

import { ItemFlagSchema, SourceSchema, TierSchema } from '@trendr/core';
import { JOB_TYPES, RUN_STATUSES } from '@trendr/db';

import { IdParam, PageMeta } from './common.js';

/**
 * Spec §10.1 admin endpoints — wire schemas. The ingest body is a
 * discriminated union because the spec's `{ source, type, strategy?, tier?,
 * itemId?, days? }` shape has per-type required fields; Zod strips the
 * irrelevant optional keys just like the loose spelling would.
 */

/** `/v1/admin/runs` and `/v1/admin/dlq` page size (the spec lists no `limit`). */
export const ADMIN_PAGE_SIZE = 50;

const ITEM_ID = z.string().regex(/^\d{1,19}$/);

export const AdminIngestBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('discover'),
    source: SourceSchema,
    strategy: z.string().min(1).max(80).default('new-hot'),
    maxItems: z.number().int().min(1).max(5_000).default(500),
  }),
  z.object({
    type: z.literal('snapshot'),
    source: SourceSchema,
    tier: TierSchema,
  }),
  z.object({
    type: z.literal('daily'),
    source: SourceSchema,
  }),
  z.object({
    type: z.literal('backfill'),
    source: SourceSchema,
    itemId: ITEM_ID,
    days: z.number().int().min(1).max(365).default(60),
  }),
  z.object({
    type: z.literal('refresh-item'),
    source: SourceSchema,
    itemId: ITEM_ID,
  }),
]);
export type AdminIngestBodyInput = z.infer<typeof AdminIngestBody>;

export const AdminIngestResponse = z.object({
  jobId: z.string(),
  queue: z.string(),
});

export const AdminScoreBody = z.object({
  source: z.union([SourceSchema, z.literal('all')]),
});
export const AdminScoreJob = z.object({
  source: SourceSchema,
  jobId: z.string(),
  queue: z.string(),
});
export const AdminScoreResponse = z.object({ jobs: z.array(AdminScoreJob) });

export const AdminRunsQuery = z.object({
  source: SourceSchema.optional(),
  jobType: z.enum(JOB_TYPES).optional(),
  status: z.enum(RUN_STATUSES).optional(),
  from: z.iso.datetime().optional(),
  cursor: z.string().optional(),
});
export type AdminRunsQueryInput = z.infer<typeof AdminRunsQuery>;

/** Keyset cursor: `k` = last run id of the page (newest-first ordering). */
export const AdminRunsCursor = z.object({ k: z.string() });

export const AdminRunSummary = z.object({
  id: z.string(),
  source: SourceSchema.nullable(),
  jobType: z.enum(JOB_TYPES),
  jobId: z.string(),
  attempt: z.number().int(),
  status: z.enum(RUN_STATUSES),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  itemsSeen: z.number().int(),
  itemsUpserted: z.number().int(),
  itemsFailed: z.number().int(),
  apiCalls: z.number().int(),
  notModified: z.number().int(),
  rateLimitRemaining: z.number().int().nullable(),
  error: z.string().nullable(),
});
export const AdminRunDetail = AdminRunSummary.extend({
  params: z.record(z.string(), z.unknown()),
});
export const AdminRunsResponse = z.object({
  runs: z.array(AdminRunSummary),
  page: PageMeta,
});
export const AdminRunResponse = AdminRunDetail;

export const AdminQueueCounts = z.object({
  waiting: z.number().int(),
  active: z.number().int(),
  delayed: z.number().int(),
  failed: z.number().int(),
  completed: z.number().int(),
});
export const AdminQueuesResponse = z.object({
  queues: z.array(z.object({ name: z.string(), counts: AdminQueueCounts })),
});

export const AdminDlqQuery = z.object({ cursor: z.string().optional() });
export const AdminDlqParams = z.object({ jobId: z.string().min(1).max(200) });

/** DLQ cursor: `o` = offset into the newest-first dead-letter list. */
export const AdminDlqCursor = z.object({ o: z.number().int().min(0) });

export const AdminDlqJob = z.object({
  id: z.string(),
  originalQueue: z.string(),
  name: z.string(),
  jobId: z.string().nullable(),
  failedReason: z.string(),
  attemptsMade: z.number().int(),
  failedAt: z.string(),
  data: z.unknown(),
});
export const AdminDlqResponse = z.object({
  jobs: z.array(AdminDlqJob),
  page: PageMeta,
});
export const AdminDlqRetryResponse = z.object({
  queue: z.string(),
  jobId: z.string(),
});

export const AdminApiBucket = z.object({
  /** Redis key (`apirl:{keyId|userId|ip}`). */
  key: z.string(),
  count: z.number().int(),
  /** Remaining window in ms; null when the counter has no expiry. */
  ttlMs: z.number().int().nullable(),
});
export const AdminTokenBucket = z.object({
  name: z.string(),
  capacity: z.number().nullable(),
  refillPerSec: z.number().nullable(),
  /** Estimated tokens available right now (stored tokens + refill). */
  tokens: z.number(),
  observedAt: z.iso.datetime().nullable(),
  pausedUntil: z.iso.datetime().nullable(),
});
export const AdminUpstreamRateLimit = z.object({
  source: SourceSchema,
  resource: z.string(),
  remaining: z.number().int(),
  resetAt: z.iso.datetime().nullable(),
  observedAt: z.iso.datetime(),
});
export const AdminRateLimitsResponse = z.object({
  api: z.array(AdminApiBucket),
  buckets: z.array(AdminTokenBucket),
  upstream: z.array(AdminUpstreamRateLimit),
});

export const AdminItemPatchBody = z
  .object({
    tier: TierSchema.optional(),
    addFlags: z.array(ItemFlagSchema).max(20).optional(),
    removeFlags: z.array(ItemFlagSchema).max(20).optional(),
  })
  .refine(
    (patch) =>
      patch.tier !== undefined || patch.addFlags !== undefined || patch.removeFlags !== undefined,
    { message: 'at least one of tier, addFlags, removeFlags is required' },
  );
export type AdminItemPatchInput = z.infer<typeof AdminItemPatchBody>;

export const AdminItemPatchResponse = z.object({
  id: z.string(),
  tier: TierSchema,
  flags: z.array(z.string()),
  updatedAt: z.iso.datetime(),
});

export const AdminItemParams = IdParam;
export const AdminRunParams = z.object({ runId: ITEM_ID });

export type AdminIngestResponseBody = z.infer<typeof AdminIngestResponse>;
export type AdminScoreResponseBody = z.infer<typeof AdminScoreResponse>;
export type AdminRunSummaryBody = z.infer<typeof AdminRunSummary>;
export type AdminRunDetailBody = z.infer<typeof AdminRunDetail>;
export type AdminRunsResponseBody = z.infer<typeof AdminRunsResponse>;
export type AdminQueuesResponseBody = z.infer<typeof AdminQueuesResponse>;
export type AdminQueueCountsBody = z.infer<typeof AdminQueueCounts>;
export type AdminDlqJobBody = z.infer<typeof AdminDlqJob>;
export type AdminDlqResponseBody = z.infer<typeof AdminDlqResponse>;
export type AdminDlqRetryResponseBody = z.infer<typeof AdminDlqRetryResponse>;
export type AdminRateLimitsResponseBody = z.infer<typeof AdminRateLimitsResponse>;
export type AdminItemPatchResponseBody = z.infer<typeof AdminItemPatchResponse>;
