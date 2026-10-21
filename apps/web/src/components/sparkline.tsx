import { cn } from '@/lib/utils';

export interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
  showArea?: boolean;
}

function buildSparkline(values: number[], width: number, height: number) {
  const pad = 2;
  const usableWidth = Math.max(1, width - pad * 2);
  const usableHeight = Math.max(1, height - pad * 2);
  const points = values.length === 0 ? [0, 0] : values;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min;
  const step = points.length > 1 ? usableWidth / (points.length - 1) : 0;

  const coords = points.map((value, index) => {
    const ratio = range === 0 ? 0.5 : (value - min) / range;
    const x = pad + index * step;
    const y = pad + (1 - ratio) * usableHeight;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))] as const;
  });

  const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x},${y}`).join(' ');
  const [lastX, lastY] = coords.at(-1) ?? [width - pad, height / 2];
  const area = `${line} L${lastX},${height - pad} L${pad},${height - pad} Z`;

  return { line, area, lastX, lastY };
}

export function Sparkline({
  values,
  width = 92,
  height = 28,
  className,
  showArea = true,
}: SparklineProps) {
  const { line, area, lastX, lastY } = buildSparkline(values, width, height);
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  const positive = last >= first;

  return (
    <svg
      aria-hidden="true"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn(
        'overflow-visible',
        positive ? 'text-emerald-500 dark:text-emerald-400' : 'text-rose-500 dark:text-rose-400',
        className,
      )}
    >
      {showArea && <path d={area} fill="currentColor" opacity={0.1} />}
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={lastX} cy={lastY} r={1.8} fill="currentColor" />
    </svg>
  );
}
