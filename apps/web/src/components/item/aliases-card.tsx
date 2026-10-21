import { ArrowDownLeft, ArrowUpRight, Waypoints } from 'lucide-react';

import { SourceBadge } from '@/components/source-badge';
import { SCOPE_LABELS } from '@/lib/constants';
import { formatPercent } from '@/lib/format';
import type { ItemAliasesResponse } from '@/lib/schemas';

export function AliasesCard({ aliases }: { aliases: ItemAliasesResponse | null }) {
  const links = aliases?.aliases ?? [];

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="aliases-title"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 id="aliases-title" className="text-sm font-semibold">
            Also on other sources
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Alias links resolve the same project across registries.
          </p>
        </div>
        <Waypoints aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </div>
      {links.length === 0 ? (
        <p className="px-4 py-6 text-[11px] text-muted-foreground">
          No cross-source aliases have been discovered for this item yet.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {links.map((alias) => (
            <li key={`${alias.source}-${alias.id}`} className="flex items-start gap-3 px-4 py-2.5">
              <SourceBadge source={alias.source} className="mt-0.5" />
              <div className="min-w-0 flex-1">
                <a
                  href={alias.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block truncate text-xs font-medium hover:underline"
                >
                  {alias.displayName}
                </a>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {SCOPE_LABELS[alias.source]} {alias.kind.replaceAll('_', ' ')} ·{' '}
                  {alias.relation.replaceAll('_', ' ')} · {formatPercent(alias.confidence)}{' '}
                  confidence
                </p>
                <p className="mt-0.5 text-[10px] text-muted-foreground/80">{alias.evidence}</p>
              </div>
              {alias.direction === 'outgoing' ? (
                <ArrowUpRight
                  aria-label="outgoing alias"
                  className="mt-1 size-3 text-muted-foreground"
                />
              ) : (
                <ArrowDownLeft
                  aria-label="incoming alias"
                  className="mt-1 size-3 text-muted-foreground"
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
