/**
 * Outbound-link hygiene for upstream data. Homepages are rendered as anchors,
 * so only absolute `http:`/`https:` URLs may be stored or rendered;
 * `javascript:`, `data:`, scheme-relative and relative values all become
 * `null`.
 *
 * The cleaned input is returned (rather than `URL#href`) so existing payloads
 * keep their exact spelling; the parse still rejects anything that is not an
 * absolute HTTP(S) URL.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (cleaned === '') return null;
  try {
    const url = new URL(cleaned);
    return url.protocol === 'http:' || url.protocol === 'https:' ? cleaned : null;
  } catch {
    return null;
  }
}
