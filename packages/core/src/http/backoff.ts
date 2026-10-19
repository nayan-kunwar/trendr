/**
 * Spec §7.5 — "full jitter" (AWS architecture blog):
 * `sleep = random(0, min(cap, base * 2^attempt))`.
 */
export function backoffDelay(
  attempt: number,
  baseMs = 1_000,
  capMs = 5 * 60_000,
  rnd: () => number = Math.random,
): number {
  const exp = Math.min(capMs, baseMs * 2 ** attempt);
  return Math.floor(rnd() * exp);
}
