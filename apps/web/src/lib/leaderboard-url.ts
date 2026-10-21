import type { ItemKind, LeaderboardScope, Window } from '@trendr/core';

export interface LeaderboardState {
  scope: LeaderboardScope;
  window: Window;
  lang?: string | undefined;
  topic?: string | undefined;
  kind?: ItemKind | undefined;
  newOnly: boolean;
}

export interface LeaderboardPatch {
  scope?: LeaderboardScope;
  window?: Window;
  /** `null` clears the filter; `undefined` keeps the current value. */
  lang?: string | null;
  topic?: string | null;
  kind?: ItemKind | null;
  newOnly?: boolean;
}

/** Build the canonical leaderboard URL used by every filter control. */
export function buildLeaderboardHref(
  current: LeaderboardState,
  patch: LeaderboardPatch = {},
): string {
  const scope = patch.scope ?? current.scope;
  const window = patch.window ?? current.window;
  const lang = patch.lang === undefined ? current.lang : (patch.lang ?? undefined);
  const topic = patch.topic === undefined ? current.topic : (patch.topic ?? undefined);
  const kind = patch.kind === undefined ? current.kind : (patch.kind ?? undefined);
  const newOnly = patch.newOnly ?? current.newOnly;

  const params = new URLSearchParams();
  if (lang !== undefined) params.set('lang', lang);
  if (topic !== undefined) params.set('topic', topic);
  if (kind !== undefined) params.set('kind', kind);
  if (newOnly) params.set('new', 'true');
  const query = params.toString();
  return `/trending/${scope}/${window}${query.length > 0 ? `?${query}` : ''}`;
}
