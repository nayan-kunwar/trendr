'use client';

import { useId, useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { formatCompact, formatInteger, formatUtcDateShort } from '@/lib/format';

type Range = '7d' | '30d' | '90d' | '1y';
type MetricKind = 'cumulative' | 'daily_count' | 'gauge';

const RANGE_DAYS: Record<Range, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  '1y': 365,
};

export interface MetricHistoryChartProps {
  points: { t: string; v: number }[];
  kind: MetricKind;
  metricLabel: string;
}

export function MetricHistoryChart({ points, kind, metricLabel }: MetricHistoryChartProps) {
  const [range, setRange] = useState<Range>('30d');
  const [logScale, setLogScale] = useState(false);
  const gradientId = useId().replaceAll(':', '');

  const visible = useMemo(() => {
    const withMovingAverage = points.map((point, index) => {
      const window = points.slice(Math.max(0, index - 6), index + 1);
      const average = window.reduce((sum, item) => sum + item.v, 0) / window.length;
      return { ...point, ma7: Math.round(average * 100) / 100 };
    });
    const last = withMovingAverage.at(-1);
    if (last === undefined) return [];
    const cutoff = Date.parse(last.t) - RANGE_DAYS[range] * 86_400_000;
    return withMovingAverage.filter((point) => Date.parse(point.t) >= cutoff);
  }, [points, range]);

  const canLog = points.some((point) => point.v > 0);
  const showMovingAverage = kind === 'daily_count';

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="metric-chart-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 id="metric-chart-title" className="text-sm font-semibold">
            {metricLabel} over time
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {kind === 'daily_count'
              ? 'Daily observations with a 7-day moving average'
              : kind === 'cumulative'
                ? 'Cumulative level sampled daily'
                : 'Point-in-time gauge sampled daily'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ToggleGroup
            type="single"
            value={range}
            onValueChange={(value) => {
              if (value === '7d' || value === '30d' || value === '90d' || value === '1y') {
                setRange(value);
              }
            }}
            aria-label="History range"
          >
            {(['7d', '30d', '90d', '1y'] as const).map((item) => (
              <ToggleGroupItem key={item} value={item}>
                {item}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <button
            type="button"
            onClick={() => {
              setLogScale((value) => !value);
            }}
            disabled={!canLog}
            aria-pressed={logScale}
            className="rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 aria-pressed:bg-muted aria-pressed:text-foreground"
          >
            log
          </button>
        </div>
      </div>

      <div className="px-2 pt-4 pb-3 sm:px-4">
        {visible.length === 0 ? (
          <div className="flex h-60 items-center justify-center text-xs text-muted-foreground">
            No snapshots in this range yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={visible} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={(value: string) => formatUtcDateShort(value)}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                minTickGap={28}
              />
              <YAxis
                scale={logScale ? 'log' : 'auto'}
                domain={logScale ? ['auto', 'auto'] : [0, 'auto']}
                tickFormatter={(value: number) => formatCompact(value)}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={48}
                allowDataOverflow={logScale}
              />
              <Tooltip
                contentStyle={{
                  background: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 11,
                  color: 'hsl(var(--foreground))',
                }}
                labelFormatter={(label) =>
                  typeof label === 'string' ? formatUtcDateShort(label) : ''
                }
                formatter={(value) => [formatInteger(Number(value)), metricLabel]}
              />
              {kind === 'daily_count' ? (
                <Bar
                  dataKey="v"
                  fill="#10b981"
                  fillOpacity={0.45}
                  radius={[2, 2, 0, 0]}
                  name={metricLabel}
                  isAnimationActive={false}
                />
              ) : (
                <Area
                  type="monotone"
                  dataKey="v"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill={`url(#${gradientId})`}
                  name={metricLabel}
                  isAnimationActive={false}
                />
              )}
              {showMovingAverage && (
                <Line
                  type="monotone"
                  dataKey="ma7"
                  stroke="#84cc16"
                  strokeWidth={2}
                  dot={false}
                  name="7-day MA"
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
      {showMovingAverage && (
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[10.5px] text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm bg-emerald-500/50" /> {metricLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded-full bg-lime-500" /> 7-day moving average
          </span>
        </div>
      )}
    </section>
  );
}
