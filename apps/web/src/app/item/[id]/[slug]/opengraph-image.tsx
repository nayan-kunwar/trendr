import type { Source } from '@trendr/core';
import { ImageResponse } from 'next/og';

import { buildQuery, safeApiFetch } from '@/lib/api';
import { METRIC_LABELS, SCOPE_LABELS } from '@/lib/constants';
import { formatDecimal, formatGrowth } from '@/lib/format';
import { HistoryResponseSchema, ItemDetailSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const alt = 'Trendr item preview';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const SOURCE_COLORS: Record<Source, string> = {
  github: '#e6edf3',
  npm: '#f87171',
  pypi: '#60a5fa',
  huggingface: '#facc15',
  arxiv: '#fb923c',
  mcp: '#a78bfa',
};

function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1).trimEnd()}...`;
}

export default async function ItemOpenGraphImage({
  params,
}: {
  params: Promise<{ id: string; slug: string }>;
}) {
  const { id } = await params;
  const item = /^\d{1,19}$/.test(id)
    ? await safeApiFetch(`/v1/items/${id}`, ItemDetailSchema, { next: { revalidate: 300 } })
    : null;

  if (item === null) {
    return new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#09090b',
          color: '#fafafa',
          fontSize: 56,
          fontWeight: 700,
        }}
      >
        Trendr
      </div>,
      size,
    );
  }

  const now = new Date();
  const from = new Date(now.getTime() - 30 * 86_400_000);
  const history = await safeApiFetch(
    `/v1/items/${item.id}/history${buildQuery({
      metric: item.primaryMetric,
      from: from.toISOString(),
      to: now.toISOString(),
      granularity: 'day',
    })}`,
    HistoryResponseSchema,
    { next: { revalidate: 300 } },
  );

  const score = item.scores['24h'];
  const values = history?.points.slice(-30).map((point) => point.v) ?? [];
  const min = values.length > 0 ? Math.min(...values) : 0;
  const max = values.length > 0 ? Math.max(...values) : 0;
  const sourceColor = SOURCE_COLORS[item.source];
  const description =
    item.description === null ? '' : shorten(item.description.replace(/\s+/g, ' '), 150);

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#09090b',
        color: '#fafafa',
        padding: 64,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -260,
          right: -140,
          width: 700,
          height: 700,
          borderRadius: 9999,
          background: 'radial-gradient(circle, rgba(16,185,129,0.22), rgba(9,9,11,0))',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div
            style={{
              width: 44,
              height: 44,
              borderRadius: 12,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(135deg, #34d399, #d9f99d)',
              color: '#022c22',
              fontSize: 26,
              fontWeight: 800,
            }}
          >
            T
          </div>
          <span style={{ fontSize: 26, fontWeight: 700, letterSpacing: -0.5 }}>Trendr</span>
        </div>
        <div
          style={{
            display: 'flex',
            padding: '9px 16px',
            borderRadius: 9999,
            border: `1px solid ${sourceColor}55`,
            color: sourceColor,
            background: `${sourceColor}14`,
            fontSize: 18,
            fontWeight: 600,
          }}
        >
          {SCOPE_LABELS[item.source]}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 40, alignItems: 'flex-end' }}>
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
          <span
            style={{
              fontSize: item.displayName.length > 42 ? 48 : 62,
              fontWeight: 700,
              lineHeight: 1.05,
              letterSpacing: -2,
              overflow: 'hidden',
              maxHeight: 140,
            }}
          >
            {shorten(item.displayName, 76)}
          </span>
          {description.length > 0 && (
            <span
              style={{
                marginTop: 18,
                fontSize: 23,
                lineHeight: 1.35,
                color: '#a1a1aa',
                overflow: 'hidden',
                maxHeight: 68,
              }}
            >
              {description}
            </span>
          )}
          <div style={{ display: 'flex', gap: 30, marginTop: 26 }}>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 14, color: '#71717a', letterSpacing: 1.5 }}>
                {METRIC_LABELS[item.primaryMetric].toUpperCase()}
              </span>
              <span style={{ fontSize: 32, fontWeight: 700 }}>
                {formatGrowth(score?.delta ?? 0)}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 14, color: '#71717a', letterSpacing: 1.5 }}>PERCENTILE</span>
              <span style={{ fontSize: 32, fontWeight: 700 }}>
                {score === null ? '-' : `p${formatDecimal(score.percentile)}`}
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 14, color: '#71717a', letterSpacing: 1.5 }}>
                SOURCE RANK
              </span>
              <span style={{ fontSize: 32, fontWeight: 700 }}>
                {score?.rankSource == null ? '-' : `#${score.rankSource}`}
              </span>
            </div>
          </div>
        </div>

        <div
          style={{
            width: 300,
            height: 130,
            display: 'flex',
            alignItems: 'flex-end',
            gap: 5,
            paddingBottom: 10,
            borderBottom: '1px solid #27272a',
          }}
        >
          {values.length === 0 ? (
            <span style={{ fontSize: 16, color: '#52525b' }}>history warming up</span>
          ) : (
            values.map((value, index) => {
              const ratio = max === min ? 0.5 : (value - min) / (max - min);
              return (
                <div
                  key={`${index}-${value}`}
                  style={{
                    width: 5,
                    height: 12 + Math.round(ratio * 94),
                    borderRadius: 2,
                    background: index === values.length - 1 ? '#34d399' : '#3f3f46',
                  }}
                />
              );
            })
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 17, color: '#71717a' }}>
          {item.kind.replaceAll('_', ' ')} / 24h velocity
        </span>
        <span style={{ fontSize: 18, color: '#34d399', fontWeight: 600 }}>
          trendr / item {item.id}
        </span>
      </div>
    </div>,
    size,
  );
}
