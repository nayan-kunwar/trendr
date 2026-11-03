import type { DbExecutor } from '../client.js';
import { adminAuditLog } from '../schema/ops.js';

/**
 * M-6 — a durable operator audit entry. `action` is a stable verb
 * (`item.patch`, `ingest.trigger`, `score.trigger`, `dlq.retry`, `dlq.discard`);
 * `target` identifies the object the action applied to. Callers that mutate the
 * database pass their transaction so the entry commits with the change.
 */
export interface AdminAuditEntry {
  /** Admin user id; null when the caller has no authenticated user (CLI/tests). */
  actorUserId: string | null;
  action: string;
  target?: string | null;
  payload?: Record<string, unknown>;
}

export async function recordAdminAudit(db: DbExecutor, entry: AdminAuditEntry): Promise<void> {
  await db.insert(adminAuditLog).values({
    actorUserId: entry.actorUserId,
    action: entry.action,
    target: entry.target ?? null,
    payload: entry.payload ?? {},
  });
}

export type AdminAuditRow = typeof adminAuditLog.$inferSelect;
