// Pure geometry for the SVG line chart (no DOM), so it can be unit-tested.
import type { Timeframe } from '../api/types';

export interface Scale { (v: number): number }

export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0 || 1;
  return (v: number) => r0 + ((v - d0) / span) * (r1 - r0);
}

/** Index ranges [start, end] (inclusive) of consecutive non-null values. */
export function segments(values: (number | null | undefined)[]): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  values.forEach((v, i) => {
    const ok = v !== null && v !== undefined && Number.isFinite(v);
    if (ok && start < 0) start = i;
    if (!ok && start >= 0) { out.push([start, i - 1]); start = -1; }
  });
  if (start >= 0) out.push([start, values.length - 1]);
  return out;
}

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * SVG path for a line with gaps: every run of non-null samples is its own subpath, so a null
 * (missing sample) breaks the line instead of being drawn as zero. A run of a single sample is
 * drawn as a zero-length segment, which round caps render as a dot.
 */
export function linePath(t: number[], values: (number | null | undefined)[], x: Scale, y: Scale): string {
  return segments(values).map(([a, b]) => {
    let d = `M${f(x(t[a]))},${f(y(values[a] as number))}`;
    if (a === b) return `${d}L${f(x(t[a]))},${f(y(values[a] as number))}`;
    for (let i = a + 1; i <= b; i++) d += `L${f(x(t[i]))},${f(y(values[i] as number))}`;
    return d;
  }).join('');
}

/** Area under the line down to the baseline y0, per non-null run (gaps stay empty). */
export function areaPath(t: number[], values: (number | null | undefined)[], x: Scale, y: Scale, y0: number): string {
  return segments(values).filter(([a, b]) => b > a).map(([a, b]) => {
    let d = `M${f(x(t[a]))},${f(y0)}`;
    for (let i = a; i <= b; i++) d += `L${f(x(t[i]))},${f(y(values[i] as number))}`;
    return `${d}L${f(x(t[b]))},${f(y0)}Z`;
  }).join('');
}

/** Index of the sample nearest to time ts (t sorted ascending). -1 when empty. */
export function nearestIndex(t: number[], ts: number): number {
  if (t.length === 0) return -1;
  let lo = 0, hi = t.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid] < ts) lo = mid + 1; else hi = mid;
  }
  if (lo > 0 && Math.abs(t[lo - 1] - ts) <= Math.abs(t[lo] - ts)) return lo - 1;
  return lo;
}

/** Largest finite value across series (0 if none). */
export function seriesMax(all: (number | null | undefined)[][]): number {
  let m = 0;
  for (const s of all) for (const v of s) if (v !== null && v !== undefined && Number.isFinite(v) && v > m) m = v;
  return m;
}

export const TIMEFRAME_LABEL: Record<Timeframe, string> = { hour: '1 h', day: '24 h', week: '7 d', month: '30 d', year: '1 y' };
export const TIMEFRAME_AGO: Record<Timeframe, string> = { hour: '1 h ago', day: '24 h ago', week: '7 d ago', month: '30 d ago', year: '1 y ago' };

/** How often a chart over this timeframe refetches (ms). */
export const refreshMs = (tf: Timeframe) => (tf === 'hour' ? 30_000 : tf === 'day' ? 120_000 : 600_000);

/** Tooltip / table timestamp for a timeframe: clock time for short ranges, date for long. */
export function timeLabel(ts: number, tf: Timeframe): string {
  const d = new Date(ts * 1000);
  if (tf === 'hour' || tf === 'day') return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (tf === 'week' || tf === 'month') return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
