import type { ItemKind, LeaderboardScope, Metric, MetricKind, Source, Window } from '@trendr/core';

/** Client-safe labels; importing types only keeps `@trendr/core` out of the bundle where possible. */

export const SCOPES = [
  'all',
  'github',
  'npm',
  'pypi',
  'huggingface',
  'arxiv',
  'mcp',
] as const satisfies readonly LeaderboardScope[];

export const SOURCES = [
  'github',
  'npm',
  'pypi',
  'huggingface',
  'arxiv',
  'mcp',
] as const satisfies readonly Source[];

export const WINDOWS = ['24h', '7d', '30d'] as const satisfies readonly Window[];

export const KIND_OPTIONS = [
  { value: 'repo', label: 'Repositories' },
  { value: 'package', label: 'Packages' },
  { value: 'model', label: 'Models' },
  { value: 'dataset', label: 'Datasets' },
  { value: 'space', label: 'Spaces' },
  { value: 'paper', label: 'Papers' },
  { value: 'mcp_server', label: 'MCP servers' },
] as const satisfies readonly { value: ItemKind; label: string }[];

export const SCOPE_LABELS: Record<LeaderboardScope, string> = {
  all: 'All',
  github: 'GitHub',
  npm: 'npm',
  pypi: 'PyPI',
  huggingface: 'Hugging Face',
  arxiv: 'arXiv',
  mcp: 'MCP',
};

export const SOURCE_TAGLINES: Record<Source, string> = {
  github: 'Repositories ranked by star velocity',
  npm: 'Packages ranked by download growth',
  pypi: 'Packages ranked by download growth',
  huggingface: 'Models and datasets ranked by engagement',
  arxiv: 'Papers ranked by citation-grade attention',
  mcp: 'Model Context Protocol servers ranked by registry momentum',
};

export const WINDOW_LABELS: Record<Window, string> = {
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
};

export const WINDOW_SHORT_LABELS: Record<Window, string> = {
  '24h': '24h',
  '7d': '7d',
  '30d': '30d',
};

export const METRIC_KINDS: Record<Metric, MetricKind> = {
  stars: 'cumulative',
  forks: 'cumulative',
  watchers: 'cumulative',
  open_issues: 'gauge',
  downloads: 'daily_count',
  downloads_total: 'cumulative',
  likes: 'cumulative',
  upvotes: 'cumulative',
  trending_score: 'gauge',
  comments: 'cumulative',
};

export const METRIC_LABELS: Record<Metric, string> = {
  stars: 'Stars',
  forks: 'Forks',
  watchers: 'Watchers',
  open_issues: 'Open issues',
  downloads: 'Downloads',
  downloads_total: 'Total downloads',
  likes: 'Likes',
  upvotes: 'Upvotes',
  trending_score: 'Trending score',
  comments: 'Comments',
};

export const SCOPE_ACCENT: Record<LeaderboardScope, string> = {
  all: 'text-emerald-600 dark:text-emerald-400',
  github: 'text-source-github',
  npm: 'text-source-npm',
  pypi: 'text-source-pypi',
  huggingface: 'text-source-huggingface',
  arxiv: 'text-source-arxiv',
  mcp: 'text-source-mcp',
};

export const SOURCE_BADGE: Record<Source, string> = {
  github:
    'bg-[var(--srcbg-github)] text-source-github ring-[var(--srcring-github)] dark:text-source-github',
  npm: 'bg-[var(--srcbg-npm)] text-source-npm ring-[var(--srcring-npm)]',
  pypi: 'bg-[var(--srcbg-pypi)] text-source-pypi ring-[var(--srcring-pypi)]',
  huggingface:
    'bg-[var(--srcbg-huggingface)] text-source-huggingface ring-[var(--srcring-huggingface)]',
  arxiv: 'bg-[var(--srcbg-arxiv)] text-source-arxiv ring-[var(--srcring-arxiv)]',
  mcp: 'bg-[var(--srcbg-mcp)] text-source-mcp ring-[var(--srcring-mcp)]',
};

export const SOURCE_DOT: Record<Source, string> = {
  github: 'bg-source-github',
  npm: 'bg-source-npm',
  pypi: 'bg-source-pypi',
  huggingface: 'bg-source-huggingface',
  arxiv: 'bg-source-arxiv',
  mcp: 'bg-source-mcp',
};

/** Language options are fetched live; this fallback only labels common seed languages. */
export const LANGUAGE_LABELS: Record<string, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  'c++': 'C++',
  c: 'C',
  'c#': 'C#',
  ruby: 'Ruby',
  php: 'PHP',
  swift: 'Swift',
  kotlin: 'Kotlin',
  zig: 'Zig',
};
