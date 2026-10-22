/** Small, deterministic Markdown formatters for the tool text blocks. */

export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_[\]<>|])/g, '\\$1');
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const abs = Math.abs(value);
  const trim = (n: number, suffix: string): string => `${Number(n.toFixed(1)).toString()}${suffix}`;
  if (abs >= 1_000_000_000) {
    return trim(value / 1_000_000_000, 'B');
  }
  if (abs >= 1_000_000) {
    return trim(value / 1_000_000, 'M');
  }
  if (abs >= 1_000) {
    return trim(value / 1_000, 'K');
  }
  return Number.isInteger(value) ? String(value) : Number(value.toFixed(1)).toString();
}

export function formatSigned(value: number): string {
  const formatted = formatNumber(value);
  return value > 0 ? `+${formatted}` : formatted;
}

export function formatRelativeGrowth(value: number | null): string {
  return value === null ? '—' : `${formatSigned(value * 100)}%`;
}

export function truncate(value: string, max = 160): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function markdownLink(label: string, url: string): string {
  return `[${escapeMarkdown(label)}](${url})`;
}
