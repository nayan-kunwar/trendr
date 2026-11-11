'use client';

import { useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { fetchOAuthProviders, oauthStartUrl, type OAuthProviderInfo } from '@/lib/auth';

/**
 * ADR-0034 — provider buttons appear only when the API reports the provider
 * configured. Discovery failure degrades to the magic-link form rather than
 * showing a button that cannot work.
 */
export function OAuthButtons() {
  const [state, setState] = useState<{
    providers: OAuthProviderInfo[];
    returnTo: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    void fetchOAuthProviders().then((providers) => {
      if (active) setState({ providers, returnTo: postLoginTarget() });
    });
    return () => {
      active = false;
    };
  }, []);

  if (state === null || state.providers.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        {state.providers.map((provider) => (
          <Button key={provider.id} asChild variant="outline" className="w-full">
            <a href={oauthStartUrl(provider.id, state.returnTo)}>
              <ProviderMark provider={provider.id} />
              Continue with {provider.label}
            </a>
          </Button>
        ))}
      </div>
      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-[11px] uppercase tracking-wide">
          <span className="bg-card px-2 text-muted-foreground">or use email</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Protected actions write `trendr:post-login` before sending the visitor to
 * sign in (watch/alert buttons). Read it here so OAuth returns to the same
 * place the magic-link flow does.
 */
function postLoginTarget(): string {
  try {
    const target = window.sessionStorage.getItem('trendr:post-login');
    if (
      target !== null &&
      target.startsWith('/') &&
      !target.startsWith('//') &&
      !target.includes('\\')
    ) {
      return target;
    }
  } catch {
    // Storage is an optimization; fall back to the dashboard.
  }
  return '/dashboard';
}

function ProviderMark({ provider }: { provider: OAuthProviderInfo['id'] }) {
  if (provider === 'github') {
    return (
      <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4" fill="currentColor">
        <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47a5.53 5.53 0 0 1-2.4 3.63v3.02h3.88c2.27-2.09 3.54-5.17 3.54-8.89Z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.24 0 5.95-1.08 7.94-2.91l-3.88-3.02c-1.08.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.73-4.96H1.26v3.09A12 12 0 0 0 12 24Z"
      />
      <path
        fill="#FBBC05"
        d="M5.27 14.26a7.2 7.2 0 0 1 0-4.52V6.65H1.26a12 12 0 0 0 0 10.7l4.01-3.09Z"
      />
      <path
        fill="#EA4335"
        d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.44-3.44A11.96 11.96 0 0 0 12 0 12 12 0 0 0 1.26 6.65l4.01 3.09C6.22 6.89 8.87 4.75 12 4.75Z"
      />
    </svg>
  );
}
