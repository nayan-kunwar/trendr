import type { Metadata } from 'next';
import Link from 'next/link';

import { AlertsPanel } from '@/components/alerts-panel';
import { WatchlistsPanel } from '@/components/watchlists-panel';
import { Button } from '@/components/ui/button';

// Nonce-based CSP: static shells get no script nonce and cannot hydrate.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Dashboard',
  robots: { index: false, follow: false },
};

export default function DashboardPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your watchlists and alerts. Add any item from its detail page.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/settings">Account settings</Link>
        </Button>
      </div>
      <WatchlistsPanel />
      <div className="mt-6">
        <AlertsPanel />
      </div>
    </main>
  );
}
