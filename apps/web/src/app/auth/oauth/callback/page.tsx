import type { Metadata } from 'next';
import { Suspense } from 'react';

import { OAuthCallbackClient } from '@/components/oauth-callback-client';

// The nonce-based CSP only reaches scripts on per-request renders. A static
// shell ships chunk tags without a nonce, which `strict-dynamic` blocks, so
// this page would never hydrate and never run the forced session refresh.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Finishing sign-in',
  robots: { index: false, follow: false },
};

export default function OAuthCallbackPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:px-6 sm:py-20">
      <Suspense
        fallback={
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Finishing sign-in…
          </div>
        }
      >
        <OAuthCallbackClient />
      </Suspense>
    </main>
  );
}
