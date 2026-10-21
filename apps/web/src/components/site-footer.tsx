import Link from 'next/link';

const DATA_SOURCES = ['GitHub', 'npm', 'PyPI', 'Hugging Face', 'arXiv', 'MCP Registry'];

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-border">
      <div className="mx-auto grid max-w-[1400px] gap-8 px-4 py-10 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="inline-flex size-5 items-center justify-center rounded-md bg-gradient-to-br from-emerald-400 to-lime-300 text-[10px] font-black text-emerald-950">
              T
            </span>
            Trendr
          </div>
          <p className="mt-2 max-w-xs text-xs leading-relaxed text-muted-foreground">
            A cross-source growth index for the open-source ecosystem. Ranked by velocity, not raw
            popularity.
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold">Explore</p>
          <ul className="mt-3 space-y-2 text-xs text-muted-foreground">
            <li>
              <Link href="/trending/all/24h" className="hover:text-foreground">
                Leaderboard
              </Link>
            </li>
            <li>
              <Link href="/new" className="hover:text-foreground">
                New this week
              </Link>
            </li>
            <li>
              <Link href="/topics" className="hover:text-foreground">
                Topics
              </Link>
            </li>
            <li>
              <Link href="/compare" className="hover:text-foreground">
                Compare items
              </Link>
            </li>
            <li>
              <Link href="/search" className="hover:text-foreground">
                Search
              </Link>
            </li>
          </ul>
        </div>
        <div>
          <p className="text-xs font-semibold">Sources</p>
          <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground">
            {DATA_SOURCES.map((source) => (
              <li key={source}>{source}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className="border-t border-border px-4 py-4 sm:px-6">
        <p className="mx-auto max-w-[1400px] text-[11px] text-muted-foreground">
          Trendr aggregates public metadata. Scores are normalized per source and window — a rank is
          a measure of acceleration, not a verdict.
        </p>
      </div>
    </footer>
  );
}
