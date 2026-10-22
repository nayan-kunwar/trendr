'use client';

import { Bell, BellOff, ChevronDown, Loader2, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { SourceBadge } from '@/components/source-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage } from '@/lib/auth';
import { createAlert, deleteAlert, listAlertEvents, listAlerts, updateAlert } from '@/lib/alerts';
import type { Alert, AlertEvent, AlertType, Source, Window } from '@/lib/alert-schemas';
import { formatUtcDate, itemHref } from '@/lib/format';
import { listWatchlists } from '@/lib/watchlists';
import type { Watchlist } from '@/lib/watchlist-schemas';

const TYPE_LABEL: Record<AlertType, string> = {
  velocity_spike: 'Velocity spike',
  rank_entered: 'Rank entry',
  threshold_crossed: 'Threshold crossed',
  new_alias: 'New alias',
};

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

const SOURCES: Source[] = ['github', 'npm', 'pypi', 'huggingface', 'arxiv', 'mcp'];
const WINDOWS: Window[] = ['24h', '7d', '30d'];

export function AlertsPanel() {
  const { user, loading: authLoading } = useAuth();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [events, setEvents] = useState<AlertEvent[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [watchlists, setWatchlists] = useState<Watchlist[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<AlertType>('velocity_spike');
  const [windowKey, setWindowKey] = useState<Window>('24h');
  const [watchlistId, setWatchlistId] = useState('');
  const [cooldownHours, setCooldownHours] = useState(24);
  const [minPercentile, setMinPercentile] = useState(95);
  const [minDeltaMultiple, setMinDeltaMultiple] = useState(3);
  const [topN, setTopN] = useState(10);
  const [scope, setScope] = useState<'all' | Source>('all');
  const [metric, setMetric] = useState<(typeof METRICS)[number]>('stars');
  const [threshold, setThreshold] = useState(1000);

  useEffect(() => {
    if (authLoading || user === null) return;
    let active = true;
    setLoading(true);
    void Promise.all([listAlerts(), listAlertEvents(), listWatchlists()])
      .then(([alertRows, eventPage, lists]) => {
        if (!active) return;
        setAlerts(alertRows);
        setEvents(eventPage.events);
        setNextCursor(eventPage.nextCursor);
        setWatchlists(lists);
        setWatchlistId((current) => current || (lists[0]?.id ?? ''));
      })
      .catch((cause: unknown) => {
        if (active) setError(authErrorMessage(cause, 'Could not load alerts.'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [authLoading, user]);

  if (authLoading || user === null) return null;

  async function onCreate(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    if (creating) return;
    if (type !== 'rank_entered' && watchlistId === '') {
      setError('Create a watchlist first, or add an alert from an item page.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const params: { type: AlertType } & Record<string, unknown> =
        type === 'velocity_spike'
          ? { type, minPercentile, minDeltaMultiple }
          : type === 'rank_entered'
            ? { type, topN, scope }
            : type === 'threshold_crossed'
              ? { type, metric, value: threshold }
              : { type };
      const created = await createAlert({
        window: windowKey,
        cooldownHours,
        params,
        ...(type === 'rank_entered' ? {} : watchlistId === '' ? {} : { watchlistId }),
      });
      setAlerts((current) => [created, ...current]);
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not create that alert.'));
    } finally {
      setCreating(false);
    }
  }

  async function onToggle(alert: Alert) {
    setBusyId(alert.id);
    setError(null);
    try {
      const updated = await updateAlert(alert.id, { enabled: !alert.enabled });
      setAlerts((current) => current.map((row) => (row.id === alert.id ? updated : row)));
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not update that alert.'));
    } finally {
      setBusyId(null);
    }
  }

  async function onDelete(alert: Alert) {
    if (!window.confirm(`Delete the "${TYPE_LABEL[alert.type]}" alert rule?`)) return;
    setBusyId(alert.id);
    setError(null);
    try {
      await deleteAlert(alert.id);
      setAlerts((current) => current.filter((row) => row.id !== alert.id));
      setEvents((current) => current.filter((event) => event.alertId !== alert.id));
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not delete that alert.'));
    } finally {
      setBusyId(null);
    }
  }

  async function loadMoreEvents() {
    if (nextCursor === null) return;
    try {
      const page = await listAlertEvents(nextCursor);
      setEvents((current) => [...current, ...page.events]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not load more alert events.'));
    }
  }

  const targetLabel = (alert: Alert): string => {
    if (alert.watchlistId !== null) {
      return watchlists.find((list) => list.id === alert.watchlistId)?.name ?? 'Watchlist';
    }
    return alert.itemId === null ? 'Global board' : `Item #${alert.itemId}`;
  };

  return (
    <section className="space-y-5">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Bell aria-hidden="true" className="size-4 text-emerald-500" />
              Alerts
            </h2>
            <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
              Fired after each scoring run. Each rule has a cooldown bucket; more than five events
              in one run arrive in a single email.
            </p>
          </div>
          <Badge variant="outline">{alerts.length}/50 rules</Badge>
        </div>

        <form
          onSubmit={(event) => {
            void onCreate(event);
          }}
          className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
        >
          <label className="space-y-1.5 text-xs font-medium">
            Rule
            <select
              value={type}
              onChange={(event) => {
                setType(event.target.value as AlertType);
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-normal"
            >
              {Object.entries(TYPE_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>

          {type === 'rank_entered' ? (
            <>
              <label className="space-y-1.5 text-xs font-medium">
                Board scope
                <select
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value as 'all' | Source);
                  }}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-normal"
                >
                  <option value="all">All sources</option>
                  {SOURCES.map((source) => (
                    <option key={source} value={source}>
                      {source}
                    </option>
                  ))}
                </select>
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Top N
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={topN}
                  onChange={(event) => {
                    setTopN(Number(event.target.value));
                  }}
                />
              </label>
            </>
          ) : (
            <label className="space-y-1.5 text-xs font-medium">
              Watchlist
              <select
                value={watchlistId}
                onChange={(event) => {
                  setWatchlistId(event.target.value);
                }}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-normal"
              >
                {watchlists.length === 0 ? <option value="">No watchlists yet</option> : null}
                {watchlists.map((list) => (
                  <option key={list.id} value={list.id}>
                    {list.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          <label className="space-y-1.5 text-xs font-medium">
            Window
            <select
              value={windowKey}
              onChange={(event) => {
                setWindowKey(event.target.value as Window);
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm font-normal"
            >
              {WINDOWS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>

          {type === 'velocity_spike' ? (
            <>
              <label className="space-y-1.5 text-xs font-medium">
                Min percentile
                <Input
                  type="number"
                  min={50}
                  max={100}
                  value={minPercentile}
                  onChange={(event) => {
                    setMinPercentile(Number(event.target.value));
                  }}
                />
              </label>
              <label className="space-y-1.5 text-xs font-medium">
                Delta vs 4-day avg (×)
                <Input
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={minDeltaMultiple}
                  onChange={(event) => {
                    setMinDeltaMultiple(Number(event.target.value));
                  }}
                />
              </label>
            </>
          ) : null}

          {type === 'threshold_crossed' ? (
            <>
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
                Crosses above
                <Input
                  type="number"
                  min={0}
                  value={threshold}
                  onChange={(event) => {
                    setThreshold(Number(event.target.value));
                  }}
                />
              </label>
            </>
          ) : null}

          <label className="space-y-1.5 text-xs font-medium">
            Cooldown (hours)
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

          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={creating} className="w-full">
              {creating ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              Add alert
            </Button>
          </div>
        </form>

        {error !== null ? (
          <p role="alert" className="mt-3 text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
        ) : null}
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 className="text-sm font-semibold">Rules</h3>
          {loading ? (
            <div className="mt-4 flex items-center text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
              Loading rules…
            </div>
          ) : alerts.length === 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              No rules yet. Add one above, or open an item and create an item-specific alert.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {alerts.map((alert) => (
                <li key={alert.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
                      {TYPE_LABEL[alert.type]}
                      <Badge variant={alert.enabled ? 'success' : 'outline'}>
                        {alert.enabled ? 'On' : 'Off'}
                      </Badge>
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {targetLabel(alert)} · {alert.window} · cooldown {alert.cooldownHours}h
                      {alert.lastTriggeredAt === null
                        ? ''
                        : ` · last fired ${formatUtcDate(alert.lastTriggeredAt)}`}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === alert.id}
                      onClick={() => {
                        void onToggle(alert);
                      }}
                    >
                      {alert.enabled ? <BellOff aria-hidden="true" /> : <Bell aria-hidden="true" />}
                      {alert.enabled ? 'Pause' : 'Resume'}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === alert.id}
                      onClick={() => {
                        void onDelete(alert);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      <span className="sr-only">Delete</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
          <h3 className="text-sm font-semibold">Recent events</h3>
          {events.length === 0 ? (
            <p className="mt-4 text-xs text-muted-foreground">
              No alert has fired yet. Events appear here after the next scoring run.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {events.map((event) => (
                <li key={event.id} className="py-3">
                  <div className="flex flex-wrap items-center gap-2 text-xs font-medium">
                    <SourceBadge source={event.item.source} />
                    <Link href={itemHref(event.item)} className="hover:underline">
                      {event.item.displayName}
                    </Link>
                    <Badge variant="outline">{TYPE_LABEL[event.alertType]}</Badge>
                  </div>
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    {event.window} · {formatUtcDate(event.triggeredAt)} ·{' '}
                    {event.deliveryStatus === 'sent' ? 'emailed' : event.deliveryStatus}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {nextCursor !== null ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                void loadMoreEvents();
              }}
            >
              <ChevronDown aria-hidden="true" />
              Load more
            </Button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
