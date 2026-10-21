'use client';

import { SlidersHorizontal, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ItemKind, LeaderboardScope, Window } from '@trendr/core';

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  KIND_OPTIONS,
  LANGUAGE_LABELS,
  SCOPES,
  SCOPE_LABELS,
  WINDOWS,
  WINDOW_SHORT_LABELS,
} from '@/lib/constants';
import { buildLeaderboardHref, type LeaderboardPatch } from '@/lib/leaderboard-url';
import type { LanguagesResponse, TopicsResponse } from '@/lib/schemas';
import { cn } from '@/lib/utils';

export interface FilterBarProps {
  scope: LeaderboardScope;
  window: Window;
  lang?: string | undefined;
  topic?: string | undefined;
  kind?: ItemKind | undefined;
  newOnly: boolean;
  languages: LanguagesResponse['languages'];
  topics: TopicsResponse['topics'];
}

export function FilterBar({
  scope,
  window,
  lang,
  topic,
  kind,
  newOnly,
  languages,
  topics,
}: FilterBarProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const activeFilterCount =
    (lang !== undefined ? 1 : 0) +
    (topic !== undefined ? 1 : 0) +
    (kind !== undefined ? 1 : 0) +
    (newOnly ? 1 : 0);

  const state = { scope, window, lang, topic, kind, newOnly };

  function navigate(next: LeaderboardPatch) {
    const href = buildLeaderboardHref(state, next);
    startTransition(() => {
      router.push(href);
    });
  }

  function clearFilters() {
    const href = buildLeaderboardHref(state, {
      lang: null,
      topic: null,
      kind: null,
      newOnly: false,
    });
    startTransition(() => {
      router.push(href);
    });
  }

  return (
    <section aria-label="Leaderboard filters" className="border-b border-border">
      <div className="flex items-center gap-1 overflow-x-auto px-2 pt-2 sm:px-3">
        {SCOPES.map((item) => {
          const active = scope === item;
          return (
            <Link
              key={item}
              href={buildLeaderboardHref(state, { scope: item })}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'relative shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                active
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {SCOPE_LABELS[item]}
              {active && (
                <span className="absolute inset-x-2 -bottom-[9px] h-0.5 rounded-full bg-emerald-500" />
              )}
            </Link>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <ToggleGroup
          type="single"
          value={window}
          onValueChange={(value) => {
            if (value === '24h' || value === '7d' || value === '30d') navigate({ window: value });
          }}
          aria-label="Time window"
        >
          {WINDOWS.map((item) => (
            <ToggleGroupItem key={item} value={item} aria-label={`Rank by ${item}`}>
              {WINDOW_SHORT_LABELS[item]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 sm:hidden"
          onClick={() => {
            setShowMobileFilters((value) => !value);
          }}
          aria-expanded={showMobileFilters}
        >
          <SlidersHorizontal aria-hidden="true" className="size-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="rounded-full bg-emerald-500/15 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
              {activeFilterCount}
            </span>
          )}
        </Button>

        <div
          className={cn(
            'flex flex-wrap items-center gap-2 sm:flex',
            showMobileFilters ? 'w-full' : 'hidden',
          )}
        >
          <Select
            value={lang ?? 'all'}
            onValueChange={(value) => {
              navigate({ lang: value === 'all' ? null : value });
            }}
          >
            <SelectTrigger className="w-[132px]" aria-label="Filter by language">
              <SelectValue placeholder="Language" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All languages</SelectItem>
              {languages.map((language) => (
                <SelectItem key={language.slug} value={language.slug}>
                  {LANGUAGE_LABELS[language.slug] ?? language.language}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={topic ?? 'all'}
            onValueChange={(value) => {
              navigate({ topic: value === 'all' ? null : value });
            }}
          >
            <SelectTrigger className="w-[132px]" aria-label="Filter by topic">
              <SelectValue placeholder="Topic" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All topics</SelectItem>
              {topics.map((item) => (
                <SelectItem key={item.slug} value={item.slug}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={kind ?? 'all'}
            onValueChange={(value) => {
              const option = KIND_OPTIONS.find((item) => item.value === value);
              navigate({ kind: option?.value ?? null });
            }}
          >
            <SelectTrigger className="w-[132px]" aria-label="Filter by kind">
              <SelectValue placeholder="Kind" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All kinds</SelectItem>
              {KIND_OPTIONS.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <label className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 text-xs text-muted-foreground">
            <Switch
              checked={newOnly}
              onCheckedChange={(checked) => {
                navigate({ newOnly: checked });
              }}
              aria-label="Show only new items"
            />
            New only
          </label>

          {activeFilterCount > 0 && (
            <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
              <X aria-hidden="true" className="size-3.5" />
              Clear
            </Button>
          )}
        </div>

        <span
          className={cn(
            'ml-auto text-[11px] text-muted-foreground transition-opacity',
            isPending ? 'opacity-100' : 'opacity-0',
          )}
          aria-live="polite"
        >
          Updating…
        </span>
      </div>
    </section>
  );
}
