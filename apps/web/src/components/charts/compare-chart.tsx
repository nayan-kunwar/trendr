'use client';

import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { METRIC_LABELS } from '@/lib/constants';
import { formatCompact, formatDecimal, formatUtcDateShort } from '@/lib/format';
import type { CompareResponse } from '@/lib/schemas';

const COLORS = ['#10b981', '#60a5fa', '#f59e0b', '#f472b6', '#a78bfa'];

export function CompareChart({ compare }: { compare: CompareResponse }) {
  const [mode, setMode] = useState<'indexed' | 'raw'>('indexed');

  const chart = useMemo(() => {
    const rows = new Map<string, Record<string, number | string>>();
    for (const item of compare.items) {
      const series = compare.series[item.id] ?? [];
      const base = series.find((point) => point.v > 0)?.v;
      for (const point of series) {
        const existing = rows.get(point.t) ?? { t: point.t };
        existing[item.id] =
          mode === 'indexed' && base !== undefined ? (point.v / base) * 100 : point.v;
        rows.set(point.t, existing);
      }
    }
    return [...rows.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  }, [compare, mode]);

  const metricLabel = compare.metric === null ? 'each item' : METRIC_LABELS[compare.metric];

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="compare-chart-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 id="compare-chart-title" className="text-sm font-semibold">
            Metric trajectories
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {metricLabel} · {compare.window} · {compare.granularity}ly points
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={mode}
          onValueChange={(value) => {
            if (value === 'indexed' || value === 'raw') setMode(value);
          }}
          aria-label="Chart scale"
        >
          <ToggleGroupItem value="indexed">Indexed</ToggleGroupItem>
          <ToggleGroupItem value="raw">Raw</ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="px-2 pt-4 pb-3 sm:px-4">
        {chart.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
            No series data for this comparison.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={chart} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
                tickFormatter={(value: number) =>
                  mode === 'indexed' ? formatDecimal(value) : formatCompact(value)
                }
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={48}
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
                formatter={(value, name) => [
                  mode === 'indexed' ? formatDecimal(Number(value)) : formatCompact(Number(value)),
                  String(name),
                ]}
              />
              {compare.items.map((item, index) => (
                <Line
                  key={item.id}
                  type="monotone"
                  dataKey={item.id}
                  name={item.displayName}
                  stroke={COLORS[index % COLORS.length]}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-border px-4 py-2.5 text-[10.5px] text-muted-foreground">
        {compare.items.map((item, index) => (
          <span key={item.id} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2 rounded-full"
              style={{ backgroundColor: COLORS[index % COLORS.length] }}
            />
            {item.displayName}
          </span>
        ))}
        <span className="ml-auto">
          {mode === 'indexed' ? 'First observed value = 100' : 'Raw metric values'}
        </span>
      </div>
    </section>
  );
}
