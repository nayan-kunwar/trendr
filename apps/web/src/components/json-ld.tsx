/**
 * Renders schema.org JSON-LD. `<` is escaped so a user-controlled description
 * can never terminate the script element (OWASP JSON-in-HTML guidance).
 */
export function JsonLd({ data }: { data: unknown }) {
  const json = JSON.stringify(data).replaceAll('<', '\\u003c');
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
