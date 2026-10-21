import { ImageResponse } from 'next/og';

import { leaderboardPath, safeApiFetch } from '@/lib/api';
import { SCOPE_LABELS, WINDOW_LABELS } from '@/lib/constants';
import { isLeaderboardScope } from '@/lib/leaderboard';
import { TrendingResponseSchema } from '@/lib/schemas';

export const runtime = 'nodejs';
export const alt = 'Trendr leaderboard preview';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function LeaderboardOpenGraphImage({
  params,
}: {
  params: Promise<{ scope: string }>;
}) {
  const { scope } = await params;
  const validScope = isLeaderboardScope(scope) ? scope : 'all';
  const board = await safeApiFetch(
    leaderboardPath({ scope: validScope, window: '24h', limit: 3 }),
    TrendingResponseSchema,
    { next: { revalidate: 120 } },
  );

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
          background: 'radial-gradient(circle, rgba(16,185,129,0.2), rgba(9,9,11,0))',
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
          <span style={{ fontSize: 26, fontWeight: 700 }}>Trendr</span>
        </div>
        <span style={{ fontSize: 18, color: '#34d399', fontWeight: 600 }}>
          {WINDOW_LABELS['24h']} leaderboard
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <span style={{ fontSize: 68, fontWeight: 700, letterSpacing: -2.5 }}>
          {SCOPE_LABELS[validScope]} trending
        </span>
        <span style={{ fontSize: 24, color: '#a1a1aa' }}>
          Ranked by growth velocity, not raw popularity.
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(board?.data ?? []).map((entry) => (
          <div
            key={entry.item.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              padding: '12px 18px',
              borderRadius: 12,
              border: '1px solid #27272a',
              background: '#111113',
            }}
          >
            <span style={{ width: 42, fontSize: 22, color: '#71717a', fontWeight: 700 }}>
              #{entry.rank}
            </span>
            <span
              style={{
                flex: 1,
                fontSize: 22,
                fontWeight: 600,
                overflow: 'hidden',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.item.displayName}
            </span>
            <span style={{ fontSize: 18, color: '#34d399', fontWeight: 600 }}>
              +{Math.round(entry.relGrowth * 100)}%
            </span>
          </div>
        ))}
        {board === null && (
          <span style={{ fontSize: 20, color: '#71717a' }}>Leaderboard warming up.</span>
        )}
      </div>

      <span style={{ fontSize: 18, color: '#34d399', fontWeight: 600 }}>trendr / trending</span>
    </div>,
    size,
  );
}
