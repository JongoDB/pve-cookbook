import { ApiError } from '../api/http';

export const SESSION_ENDED = 'Your session ended. Log in again.';

export const SETUP_CODE_HELP = 'Printed by the installer, or in /var/lib/galley/setup-token on the galley host.';

/** "Too many attempts. Try again in N seconds." (N rounded up, at least 1) */
export function rateLimitMessage(seconds: number): string {
  const n = Math.max(1, Math.ceil(seconds));
  return `Too many attempts. Try again in ${n} second${n === 1 ? '' : 's'}.`;
}

/** When a login failure is a rate limit, the epoch-ms time the button unlocks. */
export function rateLimitedUntil(e: unknown, nowMs = Date.now()): number | null {
  if (!(e instanceof ApiError) || (e.status !== 429 && e.code !== 'rate_limited')) return null;
  const secs = e.retryAfter !== undefined && e.retryAfter > 0 ? e.retryAfter : 30;
  return nowMs + secs * 1000;
}

/** Remaining whole seconds of a lockout, 0 when over. */
export const secondsLeft = (until: number | null, nowMs = Date.now()) => (until ? Math.max(0, Math.ceil((until - nowMs) / 1000)) : 0);

/** A setup-code specific message, or null when the error is about something else. */
export function setupTokenMessage(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.code === 'setup_token_required') return `Enter the setup code. ${SETUP_CODE_HELP}`;
  if (e.code === 'setup_token_invalid') return `That setup code is not valid. ${SETUP_CODE_HELP}`;
  return null;
}

const WARN_BEFORE_END_S = 10 * 60;

/** When the session's hard limit (maxExpires) is near; null when not yet. */
export function sessionEndWarning(maxExpires: number | undefined, now: number): { minutes: number; at: string } | null {
  if (!maxExpires) return null;
  const left = maxExpires - now;
  if (left > WARN_BEFORE_END_S || left <= 0) return null;
  return { minutes: Math.max(1, Math.ceil(left / 60)), at: new Date(maxExpires * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) };
}
