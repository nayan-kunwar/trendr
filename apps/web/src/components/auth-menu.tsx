'use client';

import { LogOut, Settings, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { useAuth } from '@/components/auth-provider';
import { Button } from '@/components/ui/button';

export function AuthMenu() {
  const { user, loading, signOut } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
    };
  }, [open]);

  if (loading) {
    return <span className="h-8 w-20 animate-pulse rounded-md bg-muted" aria-hidden="true" />;
  }

  if (user === null) {
    return (
      <Button asChild variant="ghost" size="sm">
        <Link href="/login">
          <UserRound aria-hidden="true" />
          <span className="hidden sm:inline">Sign in</span>
        </Link>
      </Button>
    );
  }

  const label = user.displayName ?? user.email;

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((value) => !value);
        }}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-8 max-w-40 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
          <UserRound aria-hidden="true" className="size-3.5" />
        </span>
        <span className="truncate">{label}</span>
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        >
          <div className="px-2 py-1.5">
            <p className="truncate text-xs font-medium">{label}</p>
            <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
          </div>
          <div className="my-1 h-px bg-border" />
          <Link
            href="/dashboard"
            role="menuitem"
            onClick={() => {
              setOpen(false);
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
          >
            <UserRound aria-hidden="true" className="size-3.5" />
            Dashboard
          </Link>
          <Link
            href="/settings"
            role="menuitem"
            onClick={() => {
              setOpen(false);
            }}
            className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
          >
            <Settings aria-hidden="true" className="size-3.5" />
            Settings
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut().then(() => {
                router.push('/');
              });
            }}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            <LogOut aria-hidden="true" className="size-3.5" />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
