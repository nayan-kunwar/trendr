import type { Metadata } from 'next';
import Link from 'next/link';

import { AccountClient } from '@/components/account-client';
import { ApiKeysPanel } from '@/components/api-keys-panel';
import { DigestPreferences } from '@/components/digest-preferences';
import { Button } from '@/components/ui/button';

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

export default function SettingsPage() {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settings</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Profile, weekly digest, API keys and account lifecycle.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
      <div className="space-y-5">
        <AccountClient />
        <DigestPreferences />
        <ApiKeysPanel />
      </div>
    </main>
  );
}
