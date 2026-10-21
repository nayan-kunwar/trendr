import { Search, TrendingUp } from 'lucide-react';
import Link from 'next/link';

import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';

const NAV = [
  { href: '/trending/all/24h', label: 'Trending' },
  { href: '/new', label: 'New' },
  { href: '/topics', label: 'Topics' },
  { href: '/compare', label: 'Compare' },
];

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-3 px-4 sm:gap-6 sm:px-6">
        <Link href="/" className="flex shrink-0 items-center gap-2" aria-label="Trendr home">
          <span className="inline-flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-lime-300 shadow-[0_0_0_1px_rgba(255,255,255,.08)_inset]">
            <TrendingUp aria-hidden="true" className="size-4 text-emerald-950" strokeWidth={2.6} />
          </span>
          <span className="text-[17px] font-semibold tracking-tight">Trendr</span>
        </Link>

        <nav className="hidden items-center gap-1 text-sm md:flex" aria-label="Primary">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <form action="/search" className="ml-auto hidden w-full max-w-xs sm:block">
          <label className="relative block">
            <span className="sr-only">Search items</span>
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              name="q"
              minLength={2}
              maxLength={100}
              placeholder="Search repos, packages, papers…"
              className="h-8 w-full rounded-md border border-border bg-card pr-12 pl-8 text-xs shadow-sm outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-ring"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded border border-border bg-muted px-1 font-mono text-[10px] text-muted-foreground">
              /
            </kbd>
          </label>
        </form>

        <div className="ml-auto flex items-center gap-1 sm:ml-0">
          <Button asChild variant="ghost" size="icon-sm" className="sm:hidden">
            <Link href="/search" aria-label="Search">
              <Search aria-hidden="true" />
            </Link>
          </Button>
          <ThemeToggle />
          <Button asChild size="sm" className="hidden lg:inline-flex">
            <Link href="/trending/all/24h">Open leaderboard</Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
