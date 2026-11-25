import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Timeframe } from '../api/types';
import { areaPath, linePath, linearScale, nearestIndex, seriesMax, TIMEFRAME_AGO, timeLabel } from '../lib/chart';
import { axisTicks, formatValue, type MetricUnit } from '../lib/units';

/**
 * Categorical series colours for the dark surface (#121B27), validated with the dataviz
 * palette checker (lightness band, chroma, adjacent CVD ΔE ≥ 9.4, normal-vision ΔE ≥ 19.7,
 * ≥ 3:1 contrast). Assigned in fixed order, never cycled: charts show at most five series.
 * A single series uses the accent.
 */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#9085e9', '#d55181'];
export const SINGLE_COLOR = '#9CC3E6';
export const MAX_SERIES = SERIES_COLORS.length;

export interface ChartSeries { key: string; label: string; values: (number | null)[] }

interface Props {
  /** what the chart shows, for screen readers ("CPU of pve1, pve2") */
  title: string;
  t: number[];
  series: ChartSeries[];
  unit: MetricUnit;
  timeframe: Timeframe;
  height?: number;
  /** a refresh is in flight: keep the frame, dim it */
  busy?: boolean;
  /** shown instead of the plot (error, no data) */
  message?: string | null;
}

const M = { top: 8, right: 8, bottom: 22, left: 64 };

export function seriesColor(i: number, count: number) {
  return count === 1 ? SINGLE_COLOR : SERIES_COLORS[i] ?? SERIES_COLORS[SERIES_COLORS.length - 1];
}

export function Legend({ series }: { series: ChartSeries[] }) {
  if (series.length < 2) return null;
  return (
    <div className="legend" aria-hidden="true">
      {series.map((s, i) => <span key={s.key}><i className="key" style={{ background: seriesColor(i, series.length) }} />{s.label}</span>)}
    </div>
  );
}

export function LineChart({ title, t, series, unit, timeframe, height = 160, busy = false, message }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const descId = useId();

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setWidth(Math.floor(entries[0].contentRect.width)));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const shown = series.slice(0, MAX_SERIES);
  const hasData = shown.some((s) => s.values.some((v) => v !== null && v !== undefined));
  const { max, ticks } = useMemo(() => axisTicks(unit, seriesMax(shown.map((s) => s.values))), [unit, shown]);
  const innerW = Math.max(0, width - M.left - M.right);
  const innerH = height - M.top - M.bottom;
  const t0 = t[0] ?? 0;
  const t1 = t[t.length - 1] ?? 1;
  const x = linearScale(t0, t1, M.left, M.left + innerW);
  const y = linearScale(0, max, M.top + innerH, M.top);
  const baseline = M.top + innerH;
  const single = shown.length === 1;

  const summary = useMemo(() => shown.map((s) => {
    const vals = s.values.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
    if (!vals.length) return { s, latest: null, min: null, maxV: null, gaps: s.values.length };
    let latest: number | null = null;
    for (let i = s.values.length - 1; i >= 0; i--) { const v = s.values[i]; if (v !== null && v !== undefined) { latest = v; break; } }
    return { s, latest, min: Math.min(...vals), maxV: Math.max(...vals), gaps: s.values.length - vals.length };
  }), [shown]);

  const onMove = (e: React.PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - r.left;
    const ts = t0 + ((px - M.left) / (innerW || 1)) * (t1 - t0);
    setHover(nearestIndex(t, ts));
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!t.length) return;
    const last = t.length - 1;
    if (e.key === 'ArrowLeft') { e.preventDefault(); setHover((h) => Math.max(0, (h ?? last + 1) - 1)); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); setHover((h) => Math.min(last, (h ?? -1) + 1)); }
    else if (e.key === 'Home') { e.preventDefault(); setHover(0); }
    else if (e.key === 'End') { e.preventDefault(); setHover(last); }
    else if (e.key === 'Escape') setHover(null);
  };

  const overlay = message ?? (!hasData ? (busy ? 'Loading history' : 'No samples in this range. PVE records history only while the resource exists and is reachable.') : null);
  const hx = hover !== null && t[hover] !== undefined ? x(t[hover]) : null;
  const tipLeft = hx !== null ? (hx > width - 190 ? Math.max(0, hx - 180) : hx + 12) : 0;

  return (
    <div
      className={`chart${busy ? ' w-loading' : ''}`}
      ref={box}
      tabIndex={hasData ? 0 : -1}
      role="group"
      aria-label={`${title}. Use the left and right arrow keys to read values.`}
      aria-describedby={descId}
      onKeyDown={onKey}
      onBlur={() => setHover(null)}
      style={{ minHeight: height }}
    >
      <table className="sr-only" id={descId}>
        <caption>{title}, last {TIMEFRAME_AGO[timeframe].replace(' ago', '')}</caption>
        <thead><tr><th scope="col">Series</th><th scope="col">Latest</th><th scope="col">Lowest</th><th scope="col">Highest</th></tr></thead>
        <tbody>
          {summary.map(({ s, latest, min, maxV, gaps }) => (
            <tr key={s.key}>
              <th scope="row">{s.label}{gaps ? ` (${gaps} samples missing)` : ''}</th>
              <td>{formatValue(unit, latest)}</td><td>{formatValue(unit, min)}</td><td>{formatValue(unit, maxV)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {width > 0 && (
        <svg width={width} height={height} aria-hidden="true">
          {hasData && !message && ticks.map((v) => (
            <g key={v}>
              <line className="chart-grid" x1={M.left} x2={M.left + innerW} y1={Math.round(y(v)) + 0.5} y2={Math.round(y(v)) + 0.5} />
              <text className="chart-axis" x={M.left - 8} y={y(v) + 4} textAnchor="end">{formatValue(unit, v)}</text>
            </g>
          ))}
          {hasData && !message && (
            <>
              <text className="chart-axis" x={M.left} y={height - 4}>{TIMEFRAME_AGO[timeframe]}</text>
              <text className="chart-axis" x={M.left + innerW} y={height - 4} textAnchor="end">now</text>
              {single && <path d={areaPath(t, shown[0].values, x, y, baseline)} fill={SINGLE_COLOR} fillOpacity={0.1} />}
              {shown.map((s, i) => (
                <path key={s.key} d={linePath(t, s.values, x, y)} fill="none" stroke={seriesColor(i, shown.length)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              ))}
              {hx !== null && (
                <>
                  <line className="chart-cross" x1={Math.round(hx) + 0.5} x2={Math.round(hx) + 0.5} y1={M.top} y2={baseline} />
                  {shown.map((s, i) => {
                    const v = s.values[hover!];
                    return v === null || v === undefined ? null : (
                      <circle key={s.key} cx={hx} cy={y(v)} r={4} fill={seriesColor(i, shown.length)} stroke="var(--panel)" strokeWidth={2} />
                    );
                  })}
                </>
              )}
              <rect x={M.left} y={M.top} width={innerW} height={innerH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} style={{ touchAction: 'pan-y' }} />
            </>
          )}
        </svg>
      )}
      {overlay && <div className="chart-empty">{overlay}</div>}
      {hover !== null && hx !== null && (
        <div className="tooltip" style={{ left: tipLeft, top: M.top }} role="status" aria-live="polite">
          <div className="tt-time">{timeLabel(t[hover], timeframe)}</div>
          {shown.map((s, i) => (
            <div className="tt-row" key={s.key}>
              <i className="key" style={{ background: seriesColor(i, shown.length) }} />
              <strong>{formatValue(unit, s.values[hover])}</strong>
              <span className="tt-label">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
