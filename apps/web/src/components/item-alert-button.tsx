'use client';

import { Bell, Check, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type SyntheticEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage } from '@/lib/auth';
import { createAlert } from '@/lib/alerts';
import type { AlertType, Window } from '@/lib/alert-schemas';

const METRICS = [
  'stars',
  'forks',
  'watchers',
  'open_issues',
  'downloads',
  'downloads_total',
  'likes',
  'upvotes',
  'trending_score',
  'comments',
] as const;

/** Item-page shortcut for an item-targeted alert rule. */
export function ItemAlertButton({ itemId }: { itemId: string }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<AlertType>('velocity_spike');
  const [windowKey, setWindowKey] = useState<Window>('24h');
  const [cooldownHours, setCooldownHours] = useState(24);
  const [metric, setMetric] = useState<(typeof METRICS)[number]>('stars');
  const [threshold, setThreshold] = useState(1000);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onCreate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    if (user === null) {
      window.sessionStorage.setItem('trendr:post-login', window.location.pathname);
      router.push('/login');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const params: { type: AlertType } & Record<string, unknown> =
        type === 'velocity_spike'
          ? { type, minPercentile: 95, minDeltaMultiple: 3 }
          : type === 'threshold_crossed'
            ? { type, metric, value: threshold }
            : { type };
      await createAlert({ itemId, window: windowKey, cooldownHours, params });
      setSaved(true);
      setOpen(false);
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not create that alert.'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading || saved}
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        {saved ? <Check aria-hidden="true" /> : <Bell aria-hidden="true" />}
        {saved ? 'Alert added' : 'Alert'}
      </Button>

      {open && !saved ? (
        <form
          onSubmit={(event) => {
            void onCreate(event);
          }}
          className="absolute right-0 z-30 mt-2 w-72 space-y-3 rounded-xl border border-border bg-card p-4 text-left shadow-xl"
        >
          <div className="space-y-1.5">
            <label htmlFor="item-alert-type" className="text-xs font-medium">
              Alert rule
            </label>
            <select
              id="item-alert-type"
              value={type}
              onChange={(event) => {
                setType(event.target.value as AlertType);
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
            >
              <option value="velocity_spike">Velocity spike</option>
              <option value="threshold_crossed">Threshold crossed</option>
              <option value="new_alias">New alias</option>
            </select>
          </div>

          {type === 'threshold_crossed' ? (
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1.5 text-xs font-medium">
                Metric
                <select
                  value={metric}
                  onChange={(event) => {
                    setMetric(event.target.value as (typeof METRICS)[number]);
                  }}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-normal"
                >
                  {METRICS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Above
                <Input
                  type="number"
                  min={0}
                  value={threshold}
                  onChange={(event) => {
                    setThreshold(Number(event.target.value));
                  }}
                />
              </label>
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1.5 text-xs font-medium">
              Window
              <select
                value={windowKey}
                onChange={(event) => {
                  setWindowKey(event.target.value as Window);
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-normal"
              >
                <option value="24h">24h</option>
                <option value="7d">7d</option>
                <option value="30d">30d</option>
              </select>
            </label>
            <label className="space-y-1.5 text-xs font-medium">
              Cooldown (h)
              <Input
                type="number"
                min={1}
                max={720}
                value={cooldownHours}
                onChange={(event) => {
                  setCooldownHours(Number(event.target.value));
                }}
              />
            </label>
          </div>

          {error !== null ? (
            <p role="alert" className="text-[11px] text-rose-500">
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOpen(false);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? <Loader2 aria-hidden="true" className="animate-spin" /> : null}
              Create alert
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
