import { z } from 'zod';

import { SourceSchema } from '@trendr/core';
import { jobTypeEnum } from '@trendr/db';

/**
 * Spec §10.1 — `GET /v1/stats`: public operational status. Item counts per
 * source (zero-filled) and the last successful run per source and job type.
 * `job_type_t` values come from the db enum so the wire shape cannot drift.
 */

export const JobTypeSchema = z.enum(jobTypeEnum.enumValues);

export const StatsRunDto = z.object({
  /** `null` for cross-source jobs (digest, maintenance). */
  source: SourceSchema.nullable(),
  jobType: JobTypeSchema,
  runId: z.string(),
  lastSuccessAt: z.iso.datetime(),
});

export const StatsResponse = z.object({
  /** Live (non-deleted) item counts; every source key is present. */
  items: z.record(SourceSchema, z.number().int()),
  runs: z.array(StatsRunDto),
});

export type StatsBody = z.infer<typeof StatsResponse>;
