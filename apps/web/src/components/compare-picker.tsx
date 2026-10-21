'use client';

import { GitCompare, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { Source, Window } from '@trendr/core';

import { SourceBadge } from '@/components/source-badge';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { buildQuery } from '@/lib/api';
import { WINDOWS } from '@/lib/constants';
import { cn } from '@/lib/utils';

export interface CompareCandidate {
  id: string;
  displayName: string;
  source: Source;
}

export function ComparePicker({
  candidates,
  selected,
  window,
}: {
  candidates: CompareCandidate[];
  selected: string[];
  window: Window;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [picked, setPicked] = useState<string[]>(selected);
  const [activeWindow, setActiveWindow] = useState<Window>(window);

  function toggle(id: string) {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 5) return current;
      return [...current, id];
    });
  }

  function submit() {
    if (picked.length < 2) return;
    const href = `/compare${buildQuery({ ids: picked.join(','), window: activeWindow })}`;
    startTransition(() => {
      router.push(href);
    });
  }

  const ordered = [...candidates].sort(
    (a, b) => Number(picked.includes(b.id)) - Number(picked.includes(a.id)),
  );

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="compare-picker-title"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div>
          <h2 id="compare-picker-title" className="text-sm font-semibold">
            Pick 2–5 items
          </h2>
          <p className="text-[11px] text-muted-foreground">
            Selected {picked.length} of 5 · current top items on the 7-day board
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={activeWindow}
            onValueChange={(value) => {
              if (value === '24h' || value === '7d' || value === '30d') setActiveWindow(value);
            }}
            aria-label="Comparison window"
          >
            {WINDOWS.map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {item}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {picked.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setPicked([]);
              }}
            >
              <X aria-hidden="true" />
              Clear
            </Button>
          )}
        </div>
      </div>

      <ul className="max-h-80 divide-y divide-border overflow-y-auto">
        {ordered.map((candidate) => {
          const checked = picked.includes(candidate.id);
          const disabled = !checked && picked.length >= 5;
          return (
            <li key={candidate.id}>
              <label
                className={cn(
                  'flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-accent/50',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    toggle(candidate.id);
                  }}
                  className="size-3.5 accent-emerald-500"
                />
                <SourceBadge source={candidate.source} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {candidate.displayName}
                </span>
              </label>
            </li>
          );
        })}
        {ordered.length === 0 && (
          <li className="px-4 py-8 text-center text-xs text-muted-foreground">
            The candidate board is unavailable.
          </li>
        )}
      </ul>

      <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <p className="text-[10.5px] text-muted-foreground">
          Use two items from the same source for a like-for-like metric chart.
        </p>
        <Button type="button" size="sm" disabled={picked.length < 2 || isPending} onClick={submit}>
          <GitCompare aria-hidden="true" />
          {isPending ? 'Loading…' : 'Compare'}
        </Button>
      </div>
    </section>
  );
}
