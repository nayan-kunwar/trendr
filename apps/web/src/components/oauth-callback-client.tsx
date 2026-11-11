'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { refreshSession } from '@/lib/auth';

/**
 * ADR-0034 — the API callback sets the httpOnly refresh cookie on the API
 * origin and redirects here. A forced refresh is required because the H-3
 * session hint is still absent for a first-time OAuth login.
 */

const ERROR_MESSAGES = new Map<string, string>([
  ['access_denied', 'Sign-in was cancelled at the provider.'],
  ['invalid_state', 'This sign-in attempt expired or was already used. Please start again.'],
  ['invalid_request', 'The provider did not return a complete sign-in response.'],
  ['email_unverified', 'That provider account does not have a verified email address.'],
  ['account_conflict', 'That provider is already linked to a different Trendr account.'],
  ['provider_unavailable', 'The sign-in provider is temporarily unavailable. Please try again.'],
  ['oauth_failed', 'We could not complete sign-in with that provider. Please try again.'],
]);

export function OAuthCallbackClient() {
  const params = useSearchParams();
  const router = useRouter();
  const { setSessionUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const errorCode = params.get('error');
  const returnTo = params.get('return_to');

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (errorCode !== null) {
      setError(
        ERROR_MESSAGES.get(errorCode) ??
          'We could not complete sign-in with that provider. Please try again.',
      );
      return;
    }

    void refreshSession({ force: true })
      .then((user) => {
        if (user === null) {
          setError('We could not find the new session. Please try signing in again.');
          return;
        }
        setSessionUser(user);
        const stored = readPostLoginTarget();
        const target = safeTarget(returnTo) ?? stored ?? '/dashboard';
        router.replace(target);
      })
      .catch(() => {
        setError('We could not finish signing in. Please try again.');
      });
  }, [errorCode, returnTo, router, setSessionUser]);

  if (error !== null) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <AlertTriangle aria-hidden="true" className="size-5" />
        </span>
        <h1 className="mt-3 text-base font-semibold">Sign-in couldn&apos;t be completed</h1>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button asChild className="mt-4" size="sm">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center rounded-xl border border-border bg-card p-8 text-center">
      <Loader2 aria-hidden="true" className="size-6 animate-spin text-emerald-500" />
      <h1 className="mt-3 text-base font-semibold">Finishing sign-in…</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        One moment while we restore your session.
      </p>
    </div>
  );
}

function readPostLoginTarget(): string | null {
  try {
    const target = window.sessionStorage.getItem('trendr:post-login');
    window.sessionStorage.removeItem('trendr:post-login');
    return safeTarget(target);
  } catch {
    return null;
  }
}

/** Only same-origin absolute paths; mirrors the API's `sanitizeReturnTo`. */
function safeTarget(value: string | null): string | null {
  if (value === null || !value.startsWith('/') || value.startsWith('//')) return null;
  if (value.includes('\\') || value.length > 512) return null;
  return value;
}
