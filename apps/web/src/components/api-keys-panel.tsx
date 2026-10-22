'use client';

import { Check, Copy, KeyRound, Loader2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState, type SyntheticEvent } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { authErrorMessage } from '@/lib/auth';
import { createApiKey, listApiKeys, revokeApiKey } from '@/lib/api-keys';
import type { ApiKey } from '@/lib/api-key-schemas';
import { formatUtcDate } from '@/lib/format';

export function ApiKeysPanel() {
  const { user, loading: authLoading } = useAuth();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading || user === null) return;
    let active = true;
    setLoading(true);
    void listApiKeys()
      .then((rows) => {
        if (active) setKeys(rows);
      })
      .catch((cause: unknown) => {
        if (active) setError(authErrorMessage(cause, 'Could not load API keys.'));
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
    const trimmed = name.trim();
    if (trimmed.length === 0 || creating) return;
    setCreating(true);
    setError(null);
    setCopied(false);
    try {
      const created = await createApiKey(trimmed);
      setKeys((current) => [...current, created.apiKey]);
      setRevealed(created.key);
      setName('');
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not create that API key.'));
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(key: ApiKey) {
    if (revokingId !== null) return;
    if (!window.confirm(`Revoke "${key.name}"? Requests using it will start returning 401.`)) {
      return;
    }
    setRevokingId(key.id);
    setError(null);
    try {
      await revokeApiKey(key.id);
      setKeys((current) =>
        current.map((row) =>
          row.id === key.id ? { ...row, revokedAt: new Date().toISOString() } : row,
        ),
      );
      if (revealed !== null) setRevealed(null);
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not revoke that API key.'));
    } finally {
      setRevokingId(null);
    }
  }

  async function copyKey(): Promise<void> {
    if (revealed === null) return;
    try {
      await navigator.clipboard.writeText(revealed);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm sm:p-6">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <KeyRound aria-hidden="true" className="size-4 text-emerald-500" />
          API keys
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Read-only keys for the public REST API and MCP server. Up to five active keys.
        </p>
      </div>

      {revealed !== null ? (
        <div className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
            Copy this key now — it is shown only once.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto rounded-md border border-border bg-background px-2 py-1.5 text-xs">
              {revealed}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                void copyKey();
              }}
            >
              {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </div>
      ) : null}

      <form
        onSubmit={(event) => {
          void onCreate(event);
        }}
        className="mt-4 flex flex-wrap items-end gap-2"
      >
        <div className="min-w-48 flex-1 space-y-1.5">
          <label htmlFor="api-key-name" className="text-xs font-medium">
            Key name
          </label>
          <Input
            id="api-key-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            maxLength={60}
            placeholder="MCP server"
            disabled={creating}
          />
        </div>
        <Button type="submit" size="sm" disabled={creating}>
          {creating ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : (
            <Plus aria-hidden="true" />
          )}
          Create key
        </Button>
      </form>

      {error !== null ? (
        <p role="alert" className="mt-3 text-xs text-rose-600 dark:text-rose-400">
          {error}
        </p>
      ) : null}

      {loading ? (
        <div className="mt-4 flex items-center text-xs text-muted-foreground">
          <Loader2 aria-hidden="true" className="mr-2 size-4 animate-spin" />
          Loading keys…
        </div>
      ) : keys.length === 0 ? (
        <p className="mt-4 text-xs text-muted-foreground">No API keys yet.</p>
      ) : (
        <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-xs font-medium">
                  {key.name}
                  {key.revokedAt !== null ? (
                    <Badge variant="outline">Revoked</Badge>
                  ) : (
                    <Badge variant="success">Active</Badge>
                  )}
                  {key.scopes.map((scope) => (
                    <Badge key={scope} variant="outline">
                      {scope}
                    </Badge>
                  ))}
                </p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                  {key.prefix}…
                  <span className="ml-2 font-sans">
                    created {formatUtcDate(key.createdAt)}
                    {key.lastUsedAt === null ? '' : ` · last used ${formatUtcDate(key.lastUsedAt)}`}
                  </span>
                </p>
              </div>
              {key.revokedAt === null ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={revokingId === key.id}
                  onClick={() => {
                    void onRevoke(key);
                  }}
                >
                  {revokingId === key.id ? (
                    <Loader2 aria-hidden="true" className="animate-spin" />
                  ) : (
                    <Trash2 aria-hidden="true" />
                  )}
                  Revoke
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
