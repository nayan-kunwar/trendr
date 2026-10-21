import type { MetadataRoute } from 'next';

import { absoluteUrl, SITE_URL } from '@/lib/site';

// Runtime env (`WEB_PUBLIC_URL`) differs between the Docker build and serving,
// so robots must be rendered per request like the sitemap.
export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: ['/search', '/compare'],
      },
    ],
    sitemap: absoluteUrl('/sitemap.xml'),
    host: SITE_URL,
  };
}
