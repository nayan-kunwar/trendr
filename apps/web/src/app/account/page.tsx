import { redirect } from 'next/navigation';

/** Legacy Phase 7.1 route; the dashboard is the canonical account surface. */
export default function AccountPage() {
  redirect('/dashboard');
}
