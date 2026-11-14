import { redirect } from 'next/navigation';

// Nonce-based CSP: static shells get no script nonce and cannot hydrate.
export const dynamic = 'force-dynamic';

/** Legacy Phase 7.1 route; the dashboard is the canonical account surface. */
export default function AccountPage() {
  redirect('/dashboard');
}
