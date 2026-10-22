import { authFetch, authFetchVoid } from './auth';
import {
  AlertEventsResponseSchema,
  AlertSchema,
  AlertsResponseSchema,
  type Alert,
  type AlertEvent,
  type AlertType,
  type Window,
} from './alert-schemas';

export interface AlertWrite {
  itemId?: string;
  watchlistId?: string;
  window: Window;
  params: { type: AlertType } & Record<string, unknown>;
  cooldownHours: number;
}

export async function listAlerts(): Promise<Alert[]> {
  const body = await authFetch('/v1/me/alerts', AlertsResponseSchema);
  return body.alerts;
}

export function createAlert(input: AlertWrite): Promise<Alert> {
  return authFetch('/v1/me/alerts', AlertSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function updateAlert(
  id: string,
  patch: Partial<AlertWrite> & { enabled?: boolean },
): Promise<Alert> {
  return authFetch(`/v1/me/alerts/${encodeURIComponent(id)}`, AlertSchema, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
}

export function deleteAlert(id: string): Promise<void> {
  return authFetchVoid(`/v1/me/alerts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function listAlertEvents(cursor?: string): Promise<{
  events: AlertEvent[];
  nextCursor: string | null;
}> {
  const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return authFetch(`/v1/me/alert-events${query}`, AlertEventsResponseSchema);
}
