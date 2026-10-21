import { ArrowUpRight, Clock3 } from 'lucide-react';
import Link from 'next/link';

import { SourceBadge } from '@/components/source-badge';
import { formatCompact, formatDecimal, formatUtcDate, itemHref } from '@/lib/format';
import type { ItemSummary } from '@/lib/schemas';

export function ItemSummaryRow({ item }: { item: ItemSummary }) {
  return (
    <li className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-accent/50">
      <SourceBadge source={item.source} className="mt-0.5 hidden sm:inline-flex" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={itemHref({ id: item.id, displayName: item.name })}
            className="min-w-0 truncate text-sm font-semibold hover:underline"
          >
            {item.name}
          </Link>
          <span className="rounded-full border border-border px-1.5 py-0 text-[10px] text-muted-foreground">
            {item.kind.replaceAll('_', ' ')}
          </span>
          <span className="sm:hidden">
            <SourceBadge source={item.source} />
          </span>
        </div>
        {item.description !== null && (
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
            {item.description}
          </p>
        )}
        <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[10.5px] text-muted-foreground">
          {item.upstreamCreatedAt !== null && (
            <span className="inline-flex items-center gap-1">
              <Clock3 aria-hidden="true" className="size-2.5" />
              {formatUtcDate(item.upstreamCreatedAt)}
            </span>
          )}
          {item.current !== null && <span>Current: {formatCompact(item.current)}</span>}
          {item.score7d !== null && <span>7d score: {formatDecimal(item.score7d)}</span>}
        </div>
      </div>
      <a
        href={item.url}
        target="_blank"
        rel="noreferrer noopener"
        aria-label={`Open ${item.name} on the source`}
        className="mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground opacity-70 transition-opacity hover:opacity-100"
      >
        <ArrowUpRight aria-hidden="true" className="size-3.5" />
      </a>
    </li>
  );
}
