export const MAGIC_LINK_EMAIL_SUBJECT = 'Sign in to Trendr';

export interface RenderedEmail {
  html: string;
  text: string;
}

/** Minimal, provider-neutral magic-link mail; worker templates use React Email. */
export function renderMagicLinkEmail(url: string): RenderedEmail {
  const text = [
    'Sign in to Trendr',
    '',
    'Use this link to sign in. It expires in 15 minutes and can only be used once:',
    url,
    '',
    'If you did not request this email, you can ignore it.',
  ].join('\n');

  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#09090b;color:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:12px;padding:28px">
      <h1 style="margin:0 0 12px;font-size:20px">Sign in to Trendr</h1>
      <p style="margin:0 0 20px;color:#a1a1aa;line-height:1.6">
        Use the button below to sign in. This link expires in 15 minutes and can only be used once.
      </p>
      <p style="margin:0 0 20px">
        <a href="${escapeHtml(url)}" style="display:inline-block;background:#34d399;color:#022c22;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600">
          Sign in to Trendr
        </a>
      </p>
      <p style="margin:0;color:#71717a;font-size:12px;line-height:1.6">
        If you did not request this email, you can safely ignore it.
      </p>
    </div>
  </body>
</html>`;

  return { html, text };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
