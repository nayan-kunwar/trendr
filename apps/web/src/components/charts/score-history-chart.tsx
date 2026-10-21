'use client';

import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Window } from '@trendr/core';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { WINDOWS, WINDOW_LABELS } from '@/lib/constants';
import { formatDecimal, formatUtcDateShort } from '@/lib/format';
import type { ScoresResponse } from '@/lib/schemas';

export interface ScoreHistoryChartProps {
  series: Record<Window, ScoresResponse | null>;
}

export function ScoreHistoryChart({ series }: ScoreHistoryChartProps) {
  const [window, setWindow] = useState<Window>('7d');
  const points = useMemo(() => series[window]?.points ?? [], [series, window]);
  const latest = points.at(-1);

  return (
    <section
      className="rounded-xl border border-border bg-card shadow-sm"
      aria-labelledby="score-chart-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 id="score-chart-title" className="text-sm font-semibold">
            Score history
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Percentile within the source · {WINDOW_LABELS[window]} window
          </p>
        </div>
        <ToggleGroup
          type="single"
          value={window}
          onValueChange={(value) => {
            if (value === '24h' || value === '7d' || value === '30d') setWindow(value);
          }}
          aria-label="Score window"
        >
          {WINDOWS.map((item) => (
            <ToggleGroupItem key={item} value={item}>
              {item}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      <div className="px-2 pt-4 pb-3 sm:px-4">
        {points.length === 0 ? (
          <div className="flex h-52 items-center justify-center text-xs text-muted-foreground">
            No scoring runs in this window yet.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="t"
                tickFormatter={(value: string) => formatUtcDateShort(value)}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                minTickGap={30}
              />
              <YAxis
                domain={[0, 100]}
                tickFormatter={(value: number) => `${value}`}
                tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
                width={32}
              />
              <ReferenceLine y={90} stroke="hsl(var(--border))" strokeDasharray="4 4" />
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
                formatter={(value) => [`p${formatDecimal(Number(value))}`, 'Percentile']}
              />
              <Line
                type="monotone"
                dataKey="percentile"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
                name="Percentile"
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
        <span>Percentile compares eligible items in the same source and window over time.</span>
        {latest !== undefined && (
          <span className="font-mono text-foreground">
            p{formatDecimal(latest.percentile)}
            {latest.rankSource !== null ? ` · rank #${latest.rankSource}` : ''}
          </span>
        )}
      </div>
    </section>
  );
}
