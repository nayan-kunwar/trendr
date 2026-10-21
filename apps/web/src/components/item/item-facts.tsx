import { ArrowUpRight, CalendarDays, GitFork, Hash, Scale } from 'lucide-react';
import type { ReactNode } from 'react';

import { LANGUAGE_LABELS } from '@/lib/constants';
import { formatUtcDate, titleCase } from '@/lib/format';
import type { ItemDetail } from '@/lib/schemas';

export function ItemFacts({ item }: { item: ItemDetail }) {
  return (
    <section
      className="rounded-xl border border-border bg-card p-4 shadow-sm"
      aria-labelledby="facts-title"
    >
      <h2 id="facts-title" className="text-sm font-semibold">
        Item facts
      </h2>
      <dl className="mt-2 divide-y divide-border text-[11px]">
        <FactRow
          icon={<Hash aria-hidden="true" className="size-3" />}
          label="External ID"
          value={item.externalId}
          mono
        />
        <FactRow
          icon={<GitFork aria-hidden="true" className="size-3" />}
          label="Owner"
          value={item.owner ?? '—'}
        />
        <FactRow
          icon={<Scale aria-hidden="true" className="size-3" />}
          label="License"
          value={item.license ?? '—'}
        />
        <FactRow
          icon={<CalendarDays aria-hidden="true" className="size-3" />}
          label="Created upstream"
          value={formatUtcDate(item.upstreamCreatedAt)}
        />
        <FactRow label="First seen" value={formatUtcDate(item.firstSeenAt)} />
        <FactRow label="Last snapshot" value={formatUtcDate(item.lastSnapshotAt)} />
        <FactRow
          label="Language"
          value={
            item.language === null
              ? '—'
              : (LANGUAGE_LABELS[item.language.toLowerCase()] ?? titleCase(item.language))
          }
        />
      </dl>
      {item.homepage !== null && (
        <div className="mt-3">
          <a
            href={item.homepage}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[10.5px] text-muted-foreground hover:text-foreground"
          >
            Homepage <ArrowUpRight aria-hidden="true" className="size-2.5" />
          </a>
        </div>
      )}
    </section>
  );
}

function FactRow({
  icon,
  label,
  value,
  mono = false,
}: {
  icon?: ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd className={mono ? 'truncate font-mono text-[10px]' : 'truncate'} title={value}>
        {value}
      </dd>
    </div>
  );
}
