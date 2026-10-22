'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { publicApiBaseUrl } from '@/lib/api';

type State = 'loading' | 'done' | 'error';

export function UnsubscribeClient() {
  const params = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<State>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (token === null || token.length === 0) {
      setState('error');
      setMessage('This unsubscribe link is missing its token.');
      return;
    }
    let active = true;
    void fetch(`${publicApiBaseUrl()}/v1/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'x-requested-with': 'trendr' },
    })
      .then(async (response) => {
        if (!active) return;
        if (!response.ok) {
          setState('error');
          setMessage('This unsubscribe link is invalid or has expired.');
          return;
        }
        const body = (await response.json()) as { purpose?: string };
        setState('done');
        setMessage(
          body.purpose === 'alerts'
            ? 'Alert emails are now turned off.'
            : body.purpose === 'digest'
              ? 'The weekly digest is now turned off.'
              : 'Alert and digest emails are now turned off.',
        );
      })
      .catch(() => {
        if (active) {
          setState('error');
          setMessage('Could not reach Trendr. Please try again later.');
        }
      });
    return () => {
      active = false;
    };
  }, [token]);

  return (
    <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8">
      {state === 'loading' ? (
        <>
          <Loader2 aria-hidden="true" className="mx-auto size-8 animate-spin text-emerald-500" />
          <h1 className="mt-4 text-xl font-semibold">Updating your preferences…</h1>
        </>
      ) : state === 'done' ? (
        <>
          <CheckCircle2 aria-hidden="true" className="mx-auto size-8 text-emerald-500" />
          <h1 className="mt-4 text-xl font-semibold">You&apos;re unsubscribed</h1>
          <p className="mt-2 text-sm text-muted-foreground">{message}</p>
          <p className="mt-4 text-xs text-muted-foreground">
            You can re-enable emails from{' '}
            <Link href="/settings" className="underline">
              settings
            </Link>
            .
          </p>
        </>
      ) : (
        <>
          <XCircle aria-hidden="true" className="mx-auto size-8 text-rose-500" />
          <h1 className="mt-4 text-xl font-semibold">Link not valid</h1>
          <p className="mt-2 text-sm text-muted-foreground">{message}</p>
          <p className="mt-4 text-xs text-muted-foreground">
            Sign in and change your preferences from{' '}
            <Link href="/settings" className="underline">
              settings
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}
