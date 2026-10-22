import { ArrowUpRight, Hash, Star } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { MetricHistoryChart } from '@/components/charts/metric-history-chart';
import { ScoreHistoryChart } from '@/components/charts/score-history-chart';
import { AliasesCard } from '@/components/item/aliases-card';
import { ItemFacts } from '@/components/item/item-facts';
import { ScoreExplainCard } from '@/components/item/score-explain-card';
import { SourceBadge } from '@/components/source-badge';
import { ItemAlertButton } from '@/components/item-alert-button';
import { WatchButton } from '@/components/watch-button';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { METRIC_KINDS, METRIC_LABELS, SCOPE_LABELS, WINDOW_SHORT_LABELS } from '@/lib/constants';
import {
  formatCompact,
  formatDecimal,
  formatGrowth,
  formatRelGrowth,
  itemHref,
  slugify,
} from '@/lib/format';
import { getItemDetail, isItemId, loadItemActivity } from '@/lib/item-data';
import type { ItemDetail } from '@/lib/schemas';

export const dynamic = 'force-dynamic';

const siteUrl = process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000';

interface ItemPageProps {
  params: Promise<{ id: string; slug: string }>;
}

export async function generateMetadata({ params }: ItemPageProps): Promise<Metadata> {
  const { id } = await params;
  if (!isItemId(id)) return { title: 'Item not found', robots: { index: false, follow: false } };
  const item = await getItemDetail(id);
  if (item === null) return { title: 'Item not found', robots: { index: false, follow: false } };

  const canonical = `/item/${item.id}/${slugify(item.displayName)}`;
  const description =
    item.description ??
    `${item.displayName} on ${SCOPE_LABELS[item.source]} — growth velocity, metric history and score breakdown on Trendr.`;

  return {
    title: item.displayName,
    description,
    alternates: { canonical },
    openGraph: {
      title: item.displayName,
      description,
      type: 'article',
      url: canonical,
      siteName: 'Trendr',
    },
    twitter: {
      card: 'summary_large_image',
      title: item.displayName,
      description,
    },
  };
}

export default async function ItemPage({ params }: ItemPageProps) {
  const { id, slug } = await params;
  if (!isItemId(id)) notFound();
  const item = await getItemDetail(id);
  if (item === null) notFound();

  if (slug !== slugify(item.displayName)) {
    permanentRedirect(itemHref({ id: item.id, displayName: item.displayName }));
  }

  const activity = await loadItemActivity(item.id, item.primaryMetric);
  const score = item.scores['24h'];
  const current = item.latestMetrics[item.primaryMetric];
  const historyKind = activity.history?.kind ?? METRIC_KINDS[item.primaryMetric];
  const canonicalUrl = `${siteUrl}${itemHref({ id: item.id, displayName: item.displayName })}`;
  const aliasUrls = activity.aliases?.aliases.map((alias) => alias.url) ?? [];

  const itemJsonLd = {
    '@context': 'https://schema.org',
    '@type': schemaType(item.kind),
    name: item.displayName,
    alternateName: item.name !== item.displayName ? item.name : undefined,
    description: item.description ?? undefined,
    url: item.url,
    identifier: item.externalId,
    sameAs: aliasUrls.length > 0 ? aliasUrls : undefined,
    programmingLanguage: item.language ?? undefined,
    license: item.license ?? undefined,
    keywords: item.topics.length > 0 ? item.topics.join(', ') : undefined,
    dateCreated: item.upstreamCreatedAt ?? undefined,
    dateModified: item.lastSnapshotAt ?? undefined,
    isPartOf: { '@type': 'WebSite', name: 'Trendr', url: siteUrl },
  };
  const breadcrumbJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${siteUrl}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: SCOPE_LABELS[item.source],
        item: `${siteUrl}/trending/${item.source}/24h`,
      },
      { '@type': 'ListItem', position: 3, name: item.displayName, item: canonicalUrl },
    ],
  };

  return (
    <main className="mx-auto max-w-[1200px] px-4 py-6 sm:px-6 sm:py-8">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(itemJsonLd) }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: serializeJsonLd(breadcrumbJsonLd) }}
      />

      <nav
        aria-label="Breadcrumb"
        className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground"
      >
        <Link href="/" className="hover:text-foreground">
          Home
        </Link>
        <span aria-hidden="true">/</span>
        <Link href={`/trending/${item.source}/24h`} className="hover:text-foreground">
          {SCOPE_LABELS[item.source]}
        </Link>
        <span aria-hidden="true">/</span>
        <span className="max-w-[42ch] truncate text-foreground">{item.displayName}</span>
      </nav>

      <header className="relative mt-4 overflow-hidden rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="pointer-events-none absolute -top-24 right-0 h-48 w-80 rounded-full bg-emerald-500/8 blur-3xl" />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <SourceBadge source={item.source} />
              <Badge variant="outline">{item.kind.replaceAll('_', ' ')}</Badge>
              <Badge
                variant={
                  item.tier === 'hot' ? 'success' : item.tier === 'warm' ? 'amber' : 'default'
                }
              >
                {item.tier}
              </Badge>
              {item.flags.slice(0, 4).map((flag) => (
                <Badge key={flag} variant="success">
                  {flag.replaceAll('_', ' ')}
                </Badge>
              ))}
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight break-words sm:text-3xl">
              {item.displayName}
            </h1>
            {item.description !== null && (
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                {item.description}
              </p>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {item.topics.slice(0, 8).map((topic) => (
                <Link
                  key={topic}
                  href={`/trending/${item.source}/24h?topic=${encodeURIComponent(topic)}`}
                  className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10.5px] text-muted-foreground hover:text-foreground"
                >
                  {topic}
                </Link>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                Open source
                <ArrowUpRight aria-hidden="true" />
              </a>
            </Button>
            <WatchButton itemId={item.id} />
            <ItemAlertButton itemId={item.id} />
          </div>
        </div>

        <dl className="relative mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            label={METRIC_LABELS[item.primaryMetric]}
            value={current === undefined ? '—' : formatCompact(current)}
            hint="latest snapshot"
            icon={<Star aria-hidden="true" className="size-3" />}
          />
          <StatCard
            label={`Δ ${WINDOW_SHORT_LABELS['24h']}`}
            value={score === null ? '—' : formatGrowth(score.delta)}
            hint={score === null ? 'not scored' : `${formatRelGrowth(score.relGrowth)} relative`}
            tone={score !== null && score.delta < 0 ? 'negative' : 'positive'}
          />
          <StatCard
            label="Source rank"
            value={score?.rankSource == null ? '—' : `#${score.rankSource}`}
            hint={
              score?.rankAll == null
                ? 'combined rank unavailable'
                : `#${score.rankAll} across all sources`
            }
            icon={<Hash aria-hidden="true" className="size-3" />}
          />
          <StatCard
            label="Percentile"
            value={score === null ? '—' : `p${formatDecimal(score.percentile)}`}
            hint={score === null ? 'not scored' : `${item.tier} tier`}
          />
        </dl>
      </header>

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_350px]">
        <div className="space-y-5">
          <MetricHistoryChart
            points={activity.history?.points ?? []}
            kind={historyKind}
            metricLabel={METRIC_LABELS[item.primaryMetric]}
          />
          <ScoreHistoryChart series={activity.scores} />
        </div>

        <aside className="space-y-4">
          <ScoreExplainCard explain={activity.explain} metric={item.primaryMetric} />
          <AliasesCard aliases={activity.aliases} />
          <ItemFacts item={item} />
        </aside>
      </div>
    </main>
  );
}

function schemaType(kind: ItemDetail['kind']): string {
  if (kind === 'paper') return 'ScholarlyArticle';
  if (kind === 'dataset') return 'Dataset';
  if (kind === 'model' || kind === 'space' || kind === 'mcp_server') return 'SoftwareApplication';
  return 'SoftwareSourceCode';
}

function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c');
}

function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint: string;
  icon?: ReactNode;
  tone?: 'neutral' | 'positive' | 'negative';
}) {
  return (
    <div className="rounded-lg border border-border bg-background/60 px-3 py-2.5">
      <dt className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        {icon}
        {label}
      </dt>
      <dd
        className={
          tone === 'negative'
            ? 'mt-1 font-mono text-lg font-semibold text-rose-600 tabular-nums dark:text-rose-400'
            : tone === 'positive'
              ? 'mt-1 font-mono text-lg font-semibold text-emerald-600 tabular-nums dark:text-emerald-400'
              : 'mt-1 font-mono text-lg font-semibold tabular-nums'
        }
      >
        {value}
      </dd>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>
    </div>
  );
}
