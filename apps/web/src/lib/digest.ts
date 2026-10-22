import { authFetch } from './auth';
import { DigestResponseSchema, type DigestSource, type DigestSubscription } from './digest-schemas';

export interface DigestWrite {
  sources: DigestSource[];
  topics: string[];
  includeWatchlist: boolean;
  dayOfWeek: number;
  enabled: boolean;
}

export async function getDigest(): Promise<DigestSubscription | null> {
  const body = await authFetch('/v1/me/digest', DigestResponseSchema);
  return body.subscription;
}

export async function saveDigest(input: DigestWrite): Promise<DigestSubscription> {
  const body = await authFetch('/v1/me/digest', DigestResponseSchema, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (body.subscription === null) throw new Error('digest save returned no subscription');
  return body.subscription;
}
