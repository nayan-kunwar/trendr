import { ITEM_KINDS, METRICS, OAUTH_PROVIDERS, SOURCES, TIERS, WINDOWS } from '@trendr/core';
import { pgEnum } from 'drizzle-orm/pg-core';

// Postgres enum types (spec §6.2); labels come from the core const arrays so
// runtime and schema can never drift (spec §6.4).
export const sourceEnum = pgEnum('source_t', SOURCES);
export const itemKindEnum = pgEnum('item_kind_t', ITEM_KINDS);
export const tierEnum = pgEnum('tier_t', TIERS);
export const metricEnum = pgEnum('metric_t', METRICS);
export const windowEnum = pgEnum('window_t', WINDOWS);
/** Spec §6.2 `run_status_t` labels; the API's query enums derive from the same list. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
] as const;
export const runStatusEnum = pgEnum('run_status_t', RUN_STATUSES);

/** Spec §6.2 `job_type_t` labels (admin runs filter, §10.1). */
export const JOB_TYPES = [
  'discover',
  'snapshot',
  'daily',
  'backfill',
  'refresh-item',
  'score',
  'digest',
  'maintenance',
  'snapshot-fanout',
] as const;
export const jobTypeEnum = pgEnum('job_type_t', JOB_TYPES);
export const aliasRelEnum = pgEnum('alias_rel_t', [
  'same_project',
  'package_of',
  'mcp_server_of',
  'paper_code',
  'model_of_paper',
  'registry_entry_of',
]);
export const alertTypeEnum = pgEnum('alert_type_t', [
  'velocity_spike',
  'rank_entered',
  'threshold_crossed',
  'new_alias',
]);
export const userRoleEnum = pgEnum('user_role_t', ['user', 'admin']);
export const tokenKindEnum = pgEnum('token_kind_t', ['magic_link', 'refresh']);
/** OAuth identity providers; labels come from core so schema and runtime agree. */
export const oauthProviderEnum = pgEnum('oauth_provider_t', OAUTH_PROVIDERS);
