import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';
export const alt = 'Trendr — the cross-source growth index';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpenGraphImage() {
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
        padding: 72,
        position: 'relative',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: -240,
          right: -120,
          width: 640,
          height: 640,
          borderRadius: 9999,
          background: 'radial-gradient(circle, rgba(16,185,129,0.28), rgba(9,9,11,0))',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
        <div
          style={{
            width: 54,
            height: 54,
            borderRadius: 14,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, #34d399, #d9f99d)',
            color: '#022c22',
            fontSize: 32,
            fontWeight: 800,
          }}
        >
          T
        </div>
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.8 }}>Trendr</span>
          <span style={{ fontSize: 15, color: '#a1a1aa', letterSpacing: 3 }}>
            CROSS-SOURCE GROWTH INDEX
          </span>
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 22, maxWidth: 940 }}>
        <span style={{ fontSize: 72, fontWeight: 700, lineHeight: 1.05, letterSpacing: -2.5 }}>
          What developers are building right now.
        </span>
        <span style={{ fontSize: 27, color: '#a1a1aa', lineHeight: 1.35 }}>
          GitHub · npm · PyPI · Hugging Face · arXiv · MCP — ranked by acceleration, not raw
          popularity.
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', gap: 12 }}>
          {['24h', '7d', '30d'].map((window) => (
            <div
              key={window}
              style={{
                display: 'flex',
                padding: '10px 18px',
                borderRadius: 9999,
                border: '1px solid #27272a',
                background: '#111113',
                color: '#d4d4d8',
                fontSize: 18,
              }}
            >
              {window} window
            </div>
          ))}
        </div>
        <span style={{ fontSize: 20, color: '#34d399', fontWeight: 600 }}>trendr</span>
      </div>
    </div>,
    size,
  );
}
