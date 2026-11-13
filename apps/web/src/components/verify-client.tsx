'use client';

import { AlertTriangle, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { authErrorMessage, verifyMagicLink } from '@/lib/auth';

export function VerifyClient() {
  // New links carry the token in the fragment so it never reaches server or
  // proxy logs. Keep reading `?token=` for links already in flight.
  const token = useSearchParams().get('token') ?? readHashToken();
  const router = useRouter();
  const { setSessionUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    if (token === null || token.length === 0) {
      setError('This sign-in link is missing its token. Request a new one.');
      return;
    }

    void verifyMagicLink(token)
      .then((user) => {
        setSessionUser(user);
        const target = window.sessionStorage.getItem('trendr:post-login');
        window.sessionStorage.removeItem('trendr:post-login');
        router.replace(target?.startsWith('/') === true ? target : '/dashboard');
      })
      .catch((cause: unknown) => {
        setError(
          authErrorMessage(
            cause,
            'This sign-in link is invalid or has expired. Request a new one.',
          ),
        );
      });
  }, [router, setSessionUser, token]);

  if (error !== null) {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
          <AlertTriangle aria-hidden="true" className="size-5" />
        </span>
        <h1 className="mt-3 text-base font-semibold">Link couldn&apos;t be used</h1>
        <p className="mt-1 text-sm text-muted-foreground">{error}</p>
        <Button asChild className="mt-4" size="sm">
          <Link href="/login">Request a new link</Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center rounded-xl border border-border bg-card p-8 text-center">
      <Loader2 aria-hidden="true" className="size-6 animate-spin text-emerald-500" />
      <h1 className="mt-3 text-base font-semibold">Signing you in…</h1>
      <p className="mt-1 text-sm text-muted-foreground">One moment while we verify the link.</p>
    </div>
  );
}

/** `#token=…` is client-only and never appears in an access log. */
function readHashToken(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  if (hash === '') return null;
  return new URLSearchParams(hash).get('token');
}
