import { ITEM_KINDS, METRICS, SOURCES, TIERS, WINDOWS } from '@trendr/core';
import { pgEnum } from 'drizzle-orm/pg-core';

// Postgres enum types (spec §6.2); labels come from the core const arrays so
// runtime and schema can never drift (spec §6.4).
export const sourceEnum = pgEnum('source_t', SOURCES);
export const itemKindEnum = pgEnum('item_kind_t', ITEM_KINDS);
export const tierEnum = pgEnum('tier_t', TIERS);
export const metricEnum = pgEnum('metric_t', METRICS);
export const windowEnum = pgEnum('window_t', WINDOWS);
export const runStatusEnum = pgEnum('run_status_t', [
  'queued',
  'running',
  'succeeded',
  'partial',
  'failed',
  'skipped',
]);
export const jobTypeEnum = pgEnum('job_type_t', [
  'discover',
  'snapshot',
  'daily',
  'backfill',
  'refresh-item',
  'score',
  'digest',
  'maintenance',
]);
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
