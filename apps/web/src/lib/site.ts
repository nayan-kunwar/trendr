/**
 * Public origin for canonical URLs, OG images and the sitemap. `WEB_PUBLIC_URL`
 * is the browser-facing origin (compose sets it to localhost:3000 in dev); the
 * server-side API origin is deliberately separate in `api.ts`.
 */
export const SITE_URL = (process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, '');

export function absoluteUrl(path: string): string {
  return new URL(path, `${SITE_URL}/`).toString();
}
