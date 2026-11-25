import { formatBytes } from './units';

/** Sizes everywhere use binary units (KiB, MiB, GiB, TiB). */
export function bytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  return formatBytes(n);
}

export const pct = (used: number, total: number) => (total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0);

export function pctLabel(used: number, total: number): string {
  const p = pct(used, total);
  return p > 0 && p < 1 ? '<1%' : `${Math.round(p)}%`;
}

export function uptime(s: number): string {
  if (!s) return 'not running';
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export function ago(ts: number, now = Date.now() / 1000): string {
  const d = Math.max(0, Math.round(now - ts));
  if (d < 5) return 'just now';
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

export const clock = (ts: number) =>
  new Date(ts * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
