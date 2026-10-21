const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

const decimal = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
});

const utcTime = new Intl.DateTimeFormat('en-US', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'UTC',
});

const utcDate = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

const utcDateShort = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
});

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Math.abs(value) < 1_000 ? integer.format(value) : compact.format(value);
}

export function formatInteger(value: number): string {
  return integer.format(value);
}

export function formatDecimal(value: number): string {
  return decimal.format(value);
}

export function formatPercent(value: number): string {
  return percent.format(value);
}

export function formatGrowth(value: number): string {
  if (value === 0) return '0';
  return `${value > 0 ? '+' : '−'}${formatCompact(Math.abs(value))}`;
}

export function formatRelGrowth(value: number): string {
  const pct = value * 100;
  if (Math.abs(pct) >= 100) return `${pct > 0 ? '+' : '−'}${compact.format(Math.abs(pct))}%`;
  return `${pct > 0 ? '+' : ''}${decimal.format(pct)}%`;
}

export function formatScore(value: number): string {
  return decimal.format(value);
}

export function formatUtcTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 'unknown';
  return `${utcTime.format(date)} UTC`;
}

export function formatUtcDate(iso: string | null): string {
  if (iso === null) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return utcDate.format(date);
}

export function formatUtcDateShort(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return utcDateShort.format(date);
}

export function formatIsoDay(iso: string): string {
  return iso.slice(0, 10);
}

export function slugify(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : 'item';
}

export function itemHref(item: { id: string; displayName: string }): string {
  return `/item/${item.id}/${slugify(item.displayName)}`;
}

export function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

const TOPIC_WORDS: Record<string, string> = {
  ai: 'AI',
  api: 'API',
  arxiv: 'arXiv',
  aws: 'AWS',
  cli: 'CLI',
  css: 'CSS',
  django: 'Django',
  fastapi: 'FastAPI',
  gcp: 'GCP',
  github: 'GitHub',
  gitlab: 'GitLab',
  graphql: 'GraphQL',
  grpc: 'gRPC',
  html: 'HTML',
  huggingface: 'Hugging Face',
  javascript: 'JavaScript',
  kubernetes: 'Kubernetes',
  llm: 'LLM',
  llms: 'LLMs',
  llmops: 'LLMOps',
  mcp: 'MCP',
  mlops: 'MLOps',
  nextjs: 'Next.js',
  nlp: 'NLP',
  node: 'Node.js',
  nodejs: 'Node.js',
  npm: 'npm',
  openai: 'OpenAI',
  pypi: 'PyPI',
  python: 'Python',
  pytorch: 'PyTorch',
  rag: 'RAG',
  react: 'React',
  rest: 'REST',
  rust: 'Rust',
  sdk: 'SDK',
  sql: 'SQL',
  tailwind: 'Tailwind',
  tailwindcss: 'Tailwind CSS',
  tensorflow: 'TensorFlow',
  typescript: 'TypeScript',
  ui: 'UI',
  ux: 'UX',
  vue: 'Vue',
  wasm: 'Wasm',
};

/** Human-facing topic label from a normalized slug (API `name` is title-cased too aggressively). */
export function topicLabel(slug: string): string {
  return slug
    .split('-')
    .filter(Boolean)
    .map((part) => TOPIC_WORDS[part] ?? part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
