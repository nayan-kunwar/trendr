import type { ItemKind, LeaderboardScope, Window } from '@trendr/core';

import { KIND_OPTIONS, SCOPES, WINDOWS } from '@/lib/constants';

export interface LeaderboardParams {
  scope: LeaderboardScope;
  window: Window;
  lang?: string;
  topic?: string;
  kind?: ItemKind;
  newOnly: boolean;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * URL search params are the leaderboard state (spec §12.1). Invalid enum values
 * fall back to the default board rather than throwing a 400 in the UI; unknown
 * free-text values are ignored unless they match the API's filter grammar.
 */
export function isLeaderboardScope(value: string): value is LeaderboardScope {
  return (SCOPES as readonly string[]).includes(value);
}

export function isWindow(value: string): value is Window {
  return (WINDOWS as readonly string[]).includes(value);
}

function isKind(value: string | undefined): value is ItemKind {
  return KIND_OPTIONS.some((option) => option.value === value);
}

export function parseLeaderboardParams(
  rawScope: string,
  rawWindow: string | undefined,
  searchParams: RawSearchParams,
): LeaderboardParams {
  const scope = isLeaderboardScope(rawScope) ? rawScope : 'all';
  const candidateWindow = rawWindow ?? first(searchParams.window) ?? '24h';
  const window = isWindow(candidateWindow) ? candidateWindow : '24h';

  const rawLang = first(searchParams.lang)?.trim().toLowerCase();
  const lang = rawLang !== undefined && /^[a-z0-9+#.-]{1,40}$/.test(rawLang) ? rawLang : undefined;

  const rawTopic = first(searchParams.topic)?.trim().toLowerCase();
  const topic =
    rawTopic !== undefined && /^[a-z0-9][a-z0-9-]{0,49}$/.test(rawTopic) ? rawTopic : undefined;

  const rawKind = first(searchParams.kind);
  const kind = isKind(rawKind) ? rawKind : undefined;
  const rawNew = first(searchParams.new);
  const newOnly = rawNew === 'true' || rawNew === '1';

  return { scope, window, lang, topic, kind, newOnly };
}

export function canonicalLeaderboardPath(params: LeaderboardParams): string {
  return `/trending/${params.scope}/${params.window}`;
}
