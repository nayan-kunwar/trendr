'use client';

import { Loader2, LogOut, Save, ShieldAlert, UserRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage, deleteAccount, updateProfile } from '@/lib/auth';
import { formatUtcDate } from '@/lib/format';

export function AccountClient() {
  const { user, loading, setSessionUser, signOut } = useAuth();
  const router = useRouter();
  const [displayName, setDisplayName] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && user === null) router.replace('/login');
  }, [loading, router, user]);

  useEffect(() => {
    if (user !== null) setDisplayName(user.displayName ?? '');
  }, [user]);

  if (loading) {
    return (
      <div className="flex items-center justify-center rounded-xl border border-border bg-card p-12 text-sm text-muted-foreground">
        <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
        Loading your account…
      </div>
    );
  }

  if (user === null) return null;

  async function onSave(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const trimmed = displayName.trim();
      const updated = await updateProfile(trimmed.length === 0 ? null : trimmed);
      setSessionUser(updated);
      setMessage('Profile updated.');
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not save your profile. Please try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function onDelete() {
    if (deleting) return;
    if (!window.confirm('Delete your account and all watchlists, alerts and API keys?')) return;
    setDeleting(true);
    setError(null);
    try {
      await deleteAccount();
      setSessionUser(null);
      router.push('/');
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not delete your account. Please try again.'));
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <UserRound aria-hidden="true" className="size-4 text-emerald-500" />
              Profile
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your display name appears on shared watchlists. Email addresses stay private.
            </p>
          </div>
          <Badge variant={user.role === 'admin' ? 'success' : 'outline'}>
            {user.role === 'admin' ? 'Admin' : 'Member'}
          </Badge>
        </div>

        <dl className="mt-5 grid gap-3 text-xs sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Email</dt>
            <dd className="mt-0.5 font-medium">{user.email}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Email status</dt>
            <dd className="mt-0.5">
              {user.emailVerifiedAt === null ? (
                <Badge variant="amber">Unverified</Badge>
              ) : (
                <Badge variant="success">Verified</Badge>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Member since</dt>
            <dd className="mt-0.5 font-medium">{formatUtcDate(user.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last sign-in</dt>
            <dd className="mt-0.5 font-medium">{formatUtcDate(user.lastLoginAt)}</dd>
          </div>
        </dl>

        <form
          onSubmit={(event) => {
            void onSave(event);
          }}
          className="mt-5 flex flex-wrap items-end gap-2"
        >
          <div className="min-w-52 flex-1 space-y-1.5">
            <label htmlFor="display-name" className="text-xs font-medium">
              Display name
            </label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(event) => {
                setDisplayName(event.target.value);
              }}
              maxLength={80}
              placeholder="How should we address you?"
              disabled={saving}
            />
          </div>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Save aria-hidden="true" />
            )}
            Save
          </Button>
        </form>
        {message !== null ? (
          <p role="status" className="mt-3 text-xs text-emerald-600 dark:text-emerald-400">
            {message}
          </p>
        ) : null}
        {error !== null ? (
          <p role="alert" className="mt-3 text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </section>

      <section className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <h2 className="text-sm font-semibold">Session</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Signing out revokes this browser&apos;s refresh-token family. Other devices stay signed
          in.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => {
            void signOut().then(() => {
              router.push('/');
            });
          }}
        >
          <LogOut aria-hidden="true" />
          Sign out
        </Button>
      </section>

      <section className="rounded-xl border border-rose-500/30 bg-rose-500/5 p-5 sm:p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-rose-700 dark:text-rose-400">
          <ShieldAlert aria-hidden="true" className="size-4" />
          Danger zone
        </h2>
        <p className="mt-1 max-w-xl text-xs text-muted-foreground">
          Deleting your account permanently removes your profile, watchlists, alert rules, digest
          preferences and API keys. This cannot be undone.
        </p>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          className="mt-4"
          disabled={deleting}
          onClick={() => {
            void onDelete();
          }}
        >
          {deleting ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
          Delete account
        </Button>
      </section>
    </div>
  );
}
