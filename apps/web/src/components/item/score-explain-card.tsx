import { Info } from 'lucide-react';
import type { Metric } from '@trendr/core';

import { METRIC_LABELS, WINDOW_LABELS } from '@/lib/constants';
import { formatDecimal, formatPercent } from '@/lib/format';
import type { ScoreExplain } from '@/lib/schemas';

function ComponentRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/70 py-2 last:border-0">
      <dt className="text-[11px] text-muted-foreground">
        {label}
        {hint !== undefined && <span className="ml-1 opacity-60">({hint})</span>}
      </dt>
      <dd className="font-mono text-xs font-medium tabular-nums">{value}</dd>
    </div>
  );
}

export function ScoreExplainCard({
  explain,
  metric,
}: {
  explain: ScoreExplain | null;
  metric: Metric;
}) {
  if (explain === null) {
    return (
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h2 className="text-sm font-semibold">Why this score</h2>
        <p className="mt-2 text-[11px] text-muted-foreground">
          The score explanation is unavailable right now.
        </p>
      </section>
    );
  }

  const components = explain.components;
  const params = explain.params;
  const inputs = explain.inputs;

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="score-explain-title"
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 id="score-explain-title" className="text-sm font-semibold">
            Why this score
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {WINDOW_LABELS[explain.window]} window · run {explain.runId?.slice(0, 8) ?? 'n/a'}
          </p>
        </div>
        <Info aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </div>

      {components === null ? (
        <div className="px-4 py-6">
          <p className="text-xs font-medium">Not eligible in the current run</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            The item did not have enough history, fell below the growth threshold, or is outside the
            scoreable tier for this window.
          </p>
        </div>
      ) : (
        <div className="px-4 py-2">
          <dl>
            <ComponentRow label="Final score" value={formatDecimal(components.finalScore)} />
            <ComponentRow label="Raw velocity" value={formatDecimal(components.rawScore)} />
            <ComponentRow
              label="Growth"
              value={`${formatDecimal(components.delta)} / ${formatDecimal(components.base)}`}
              hint="delta / base"
            />
            <ComponentRow label="Relative growth" value={formatPercent(components.relGrowth)} />
            <ComponentRow label="Age factor" value={`${formatDecimal(components.ageFactor)}×`} />
            <ComponentRow label="Confidence" value={formatPercent(components.confidence)} />
            <ComponentRow
              label="Anomaly penalty"
              value={`${formatDecimal(components.anomalyPenalty)}×`}
            />
          </dl>
          <p className="mt-3 rounded-md bg-muted/50 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            final = raw × age × confidence × anomaly
          </p>
        </div>
      )}

      {inputs !== null && (
        <div className="border-t border-border px-4 py-3">
          <h3 className="text-[11px] font-semibold">Run context</h3>
          <dl className="mt-1 grid grid-cols-2 gap-x-4">
            <ComponentRow label="Z-score" value={formatDecimal(inputs.zScore)} />
            <ComponentRow label="Percentile" value={`p${formatDecimal(inputs.percentile)}`} />
            <ComponentRow
              label="Source rank"
              value={inputs.rankSource === null ? '—' : `#${inputs.rankSource}`}
            />
            <ComponentRow
              label="All rank"
              value={inputs.rankAll === null ? '—' : `#${inputs.rankAll}`}
            />
          </dl>
          {inputs.flags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {inputs.flags.map((flag) => (
                <span
                  key={flag}
                  className="rounded-full border border-border bg-muted/50 px-2 py-0.5 text-[10px] text-muted-foreground"
                >
                  {flag.replaceAll('_', ' ')}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {params !== null && (
        <div className="border-t border-border px-4 py-3">
          <h3 className="text-[11px] font-semibold">Scoring parameters</h3>
          <dl className="mt-1 grid grid-cols-2 gap-x-4">
            <ComponentRow label="k" value={formatDecimal(params.k)} />
            <ComponentRow label="min Δ" value={formatDecimal(params.minDelta)} />
            <ComponentRow label="β" value={formatDecimal(params.beta)} />
            <ComponentRow label="r max" value={formatDecimal(params.rMax)} />
            <ComponentRow label="burst min" value={formatDecimal(params.burstMinAbs)} />
          </dl>
        </div>
      )}

      <div className="border-t border-border px-4 py-2.5 text-[10.5px] text-muted-foreground">
        Primary metric: {METRIC_LABELS[metric]}
        {explain.computedAt !== null ? ` · scored ${explain.computedAt.slice(0, 10)}` : ''}
      </div>
    </section>
  );
}
