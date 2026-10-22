'use client';

import { Loader2, MailCheck, Send } from 'lucide-react';
import { useState, type SyntheticEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage, requestMagicLink } from '@/lib/auth';

export function LoginForm() {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending) return;
    setError(null);
    setSending(true);
    try {
      await requestMagicLink(email.trim());
      setSentTo(email.trim());
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not send the sign-in link. Please try again.'));
    } finally {
      setSending(false);
    }
  }

  if (sentTo !== null) {
    return (
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
        <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <MailCheck aria-hidden="true" className="size-5" />
        </span>
        <h2 className="mt-3 text-base font-semibold">Check your inbox</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          If an account can use <span className="font-medium text-foreground">{sentTo}</span>, a
          sign-in link is on its way. It expires in 15 minutes.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => {
            setSentTo(null);
            setEmail('');
          }}
        >
          Use a different email
        </Button>
      </div>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        void onSubmit(event);
      }}
      className="space-y-4"
    >
      <div className="space-y-1.5">
        <label htmlFor="email" className="text-xs font-medium">
          Email address
        </label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          autoFocus
          required
          maxLength={320}
          placeholder="you@example.com"
          value={email}
          onChange={(event) => {
            setEmail(event.target.value);
          }}
          disabled={sending}
        />
      </div>
      {error !== null ? (
        <p
          role="alert"
          className="rounded-md border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-600 dark:text-rose-400"
        >
          {error}
        </p>
      ) : null}
      <Button type="submit" className="w-full" disabled={sending || email.trim().length === 0}>
        {sending ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <Send aria-hidden="true" />
        )}
        {sending ? 'Sending link…' : 'Email me a sign-in link'}
      </Button>
      <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
        No password needed. Your email is only used to sign you in and deliver the alerts you
        choose.
      </p>
    </form>
  );
}
