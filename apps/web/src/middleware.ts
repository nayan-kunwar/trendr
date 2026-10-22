import { NextResponse, type NextRequest } from 'next/server';

/**
 * Spec §15 — nonce-based CSP for the Next.js surface. Next reads the nonce
 * from this header and applies it to its bootstrap and chunk scripts. There
 * are no third-party script origins; images allow remote avatars/covers.
 */
export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const apiUrl = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
  const connect = new Set(["'self'", apiUrl]);
  if (apiUrl.startsWith('https://')) connect.add(`wss://${apiUrl.slice('https://'.length)}`);
  if (apiUrl.startsWith('http://')) connect.add(`ws://${apiUrl.slice('http://'.length)}`);

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://avatars.githubusercontent.com https://cdn-avatars.huggingface.co",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('content-security-policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('content-security-policy', csp);
  response.headers.set('x-content-type-options', 'nosniff');
  return response;
}

export const config = {
  matcher: [
    // Skip Next internals and static assets; still cover every rendered route.
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)',
  ],
};
