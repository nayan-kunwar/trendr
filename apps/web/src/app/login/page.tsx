import { LogIn } from 'lucide-react';
import type { Metadata } from 'next';

import { LoginForm } from '@/components/login-form';

// Nonce-based CSP: static shells get no script nonce and cannot hydrate.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to Trendr with Google, GitHub or a one-time email link.',
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-col px-4 py-12 sm:px-6 sm:py-20">
      <div className="rounded-2xl border border-border bg-card p-6 shadow-sm sm:p-8">
        <span className="inline-flex size-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
          <LogIn aria-hidden="true" className="size-5" />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-tight">Sign in to Trendr</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Watchlists, alerts and the weekly digest live in your account. Use Google or GitHub, or
          we&apos;ll email you a one-time link — no password to remember.
        </p>
        <div className="mt-6">
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
