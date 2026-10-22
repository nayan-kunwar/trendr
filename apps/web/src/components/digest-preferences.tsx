'use client';

import { Loader2, Mail, Save } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage } from '@/lib/auth';
import { getDigest, saveDigest } from '@/lib/digest';
import type { DigestSource } from '@/lib/digest-schemas';

const SOURCE_OPTIONS: { value: DigestSource; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'npm', label: 'npm' },
  { value: 'pypi', label: 'PyPI' },
  { value: 'huggingface', label: 'Hugging Face' },
  { value: 'arxiv', label: 'arXiv' },
  { value: 'mcp', label: 'MCP / agent tools' },
];

const ALL_SOURCES = SOURCE_OPTIONS.map((option) => option.value);
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function DigestPreferences() {
  const { user, loading: authLoading } = useAuth();
  const [sources, setSources] = useState<DigestSource[]>(ALL_SOURCES);
  const [topics, setTopics] = useState('');
  const [includeWatchlist, setIncludeWatchlist] = useState(true);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [enabled, setEnabled] = useState(true);
  const [unsubscribedAt, setUnsubscribedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || user === null) return;
    let active = true;
    setLoading(true);
    void getDigest()
      .then((subscription) => {
        if (!active || subscription === null) return;
        setSources(subscription.sources);
        setTopics(subscription.topics.join(', '));
        setIncludeWatchlist(subscription.includeWatchlist);
        setDayOfWeek(subscription.dayOfWeek);
        setEnabled(subscription.enabled);
        setUnsubscribedAt(subscription.unsubscribedAt);
      })
      .catch((cause: unknown) => {
        if (active) setError(authErrorMessage(cause, 'Could not load digest preferences.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  if (authLoading || user === null) return null;

  function toggleSource(source: DigestSource): void {
    setSources((current) =>
      current.includes(source) ? current.filter((value) => value !== source) : [...current, source],
    );
  }

  async function onSave(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (sources.length === 0) {
      setError('Choose at least one source.');
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const saved = await saveDigest({
        sources,
        topics: topics
          .split(',')
          .map((topic) => topic.trim().toLowerCase())
          .filter((topic) => topic.length > 0),
        includeWatchlist,
        dayOfWeek,
        enabled,
      });
      setUnsubscribedAt(saved.unsubscribedAt);
      setMessage('Digest preferences saved.');
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not save digest preferences.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Mail aria-hidden="true" className="size-4 text-emerald-500" />
            Weekly digest
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            A Monday-morning email with the fastest-growing projects you care about.
          </p>
        </div>
        {unsubscribedAt !== null && !enabled ? (
          <Badge variant="amber">Unsubscribed</Badge>
        ) : (
          <Badge variant={enabled ? 'success' : 'outline'}>
            {enabled ? 'Subscribed' : 'Paused'}
          </Badge>
        )}
      </div>

      {loading ? (
        <div className="mt-5 flex items-center text-xs text-muted-foreground">
          <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
          Loading preferences…
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            void onSave(event);
          }}
          className="mt-5 space-y-4"
        >
          <fieldset>
            <legend className="text-xs font-medium">Sources</legend>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {SOURCE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs"
                >
                  <input
                    type="checkbox"
                    checked={sources.includes(option.value)}
                    onChange={() => {
                      toggleSource(option.value);
                    }}
                    className="size-3.5 accent-emerald-500"
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="digest-topics" className="text-xs font-medium">
                Topics (comma-separated, optional)
              </label>
              <Input
                id="digest-topics"
                value={topics}
                onChange={(event) => {
                  setTopics(event.target.value);
                }}
                placeholder="llm, agents, developer-tools"
                maxLength={500}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="digest-day" className="text-xs font-medium">
                Send on
              </label>
              <select
                id="digest-day"
                value={dayOfWeek}
                onChange={(event) => {
                  setDayOfWeek(Number(event.target.value));
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              >
                {DAYS.map((day, index) => (
                  <option key={day} value={index}>
                    {day}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={includeWatchlist}
                onChange={(event) => {
                  setIncludeWatchlist(event.target.checked);
                }}
                className="size-3.5 accent-emerald-500"
              />
              Include my watchlist
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(event) => {
                  setEnabled(event.target.checked);
                }}
                className="size-3.5 accent-emerald-500"
              />
              Digest enabled
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Save aria-hidden="true" />
              )}
              Save digest
            </Button>
            {message !== null ? (
              <span role="status" className="text-xs text-emerald-600 dark:text-emerald-400">
                {message}
              </span>
            ) : null}
            {error !== null ? (
              <span role="alert" className="text-xs text-rose-600 dark:text-rose-400">
                {error}
              </span>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}
