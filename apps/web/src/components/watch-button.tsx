'use client';

import { Check, Loader2, Star } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';
import { authErrorMessage } from '@/lib/auth';
import { addWatchlistItem, ensureDefaultWatchlist } from '@/lib/watchlists';

/** Item-page affordance; the first save auto-creates the default watchlist. */
export function WatchButton({ itemId }: { itemId: string }) {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onWatch() {
    if (state !== 'idle') return;
    if (user === null) {
      window.sessionStorage.setItem('trendr:post-login', window.location.pathname);
      router.push('/login');
      return;
    }
    setState('saving');
    setError(null);
    try {
      const watchlist = await ensureDefaultWatchlist();
      await addWatchlistItem(watchlist.id, itemId);
      setState('saved');
    } catch (cause) {
      setError(authErrorMessage(cause, 'Could not save this item. Please try again.'));
      setState('idle');
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={loading || state === 'saving' || state === 'saved'}
        onClick={() => {
          void onWatch();
        }}
        title={state === 'saved' ? 'Saved to your default watchlist' : 'Add to your watchlist'}
      >
        {state === 'saving' ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : state === 'saved' ? (
          <Check aria-hidden="true" />
        ) : (
          <Star aria-hidden="true" />
        )}
        {state === 'saved' ? 'Watching' : 'Watch'}
      </Button>
      {error !== null ? (
        <span role="alert" className="max-w-56 text-right text-[10.5px] text-rose-500">
          {error}
        </span>
      ) : null}
    </div>
  );
}
