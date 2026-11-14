import type { Metadata } from 'next';
import { Suspense } from 'react';

import { VerifyClient } from '@/components/verify-client';

// Nonce-based CSP: static shells get no script nonce and cannot hydrate.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Signing in',
  robots: { index: false, follow: false },
};

export default function VerifyPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:px-6 sm:py-20">
      <Suspense
        fallback={
          <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
            Loading sign-in link…
          </div>
        }
      >
        <VerifyClient />
      </Suspense>
    </main>
  );
}
