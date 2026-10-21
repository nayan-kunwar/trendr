import { Layers } from 'lucide-react';
import type { LeaderboardScope, Source } from '@trendr/core';

import { SourceIcon } from '@/components/source-icon';
import { SCOPE_LABELS, SOURCE_BADGE } from '@/lib/constants';
import { cn } from '@/lib/utils';

export function SourceBadge({ source, className }: { source: Source; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset',
        SOURCE_BADGE[source],
        className,
      )}
    >
      <SourceIcon source={source} />
      {SCOPE_LABELS[source]}
    </span>
  );
}

export function ScopeBadge({ scope, className }: { scope: LeaderboardScope; className?: string }) {
  if (scope !== 'all') return <SourceBadge source={scope} className={className} />;
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-500/25 ring-inset dark:text-emerald-400',
        className,
      )}
    >
      <Layers aria-hidden="true" className="size-3.5" />
      All sources
    </span>
  );
}
