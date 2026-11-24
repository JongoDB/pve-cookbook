import { useMemo } from 'react';
import type { MetricKind, MetricName, Timeframe } from '../api/types';
import { useMetrics } from '../lib/hooks';
import { METRIC_LABEL, METRIC_UNIT } from '../lib/units';
import { errMsg } from '../state/app';
import { Legend, LineChart, MAX_SERIES, type ChartSeries } from './LineChart';

export interface MetricResource { cluster: string; kind: MetricKind; id: string; label: string }

/**
 * Plots `metrics` (same unit) for each resource. Series are resource × metric, capped at
 * MAX_SERIES; the caption says when some were left out.
 */
export function useMetricSeries(resources: MetricResource[], metrics: MetricName[], timeframe: Timeframe) {
  const queries = useMemo(() => resources.map((r) => ({ cluster: r.cluster, kind: r.kind, id: r.id, timeframe })), [resources, timeframe]);
  const { data, error, loading } = useMetrics(queries, timeframe);
  return useMemo(() => {
    const series: ChartSeries[] = [];
    const errors: string[] = [];
    // one time axis: the longest answer; other series are placed on it by timestamp
    let t: number[] = [];
    for (const ms of data ?? []) if (!ms.error && ms.t.length > t.length) t = ms.t;
    (data ?? []).forEach((ms, i) => {
      const r = resources[i];
      if (!r) return;
      if (ms.error) { errors.push(`${r.label}: ${ms.error}`); return; }
      for (const m of metrics) {
        const label = [resources.length > 1 ? r.label : '', metrics.length > 1 || resources.length === 1 ? METRIC_LABEL[m] : ''].filter(Boolean).join(' ');
        const vals = ms.series[m] ?? [];
        series.push({ key: `${r.cluster}/${r.kind}/${r.id}/${m}`, label: label || METRIC_LABEL[m], values: alignTo(t, ms.t, vals) });
      }
    });
    return { t, series, errors, loading: loading || data === null, fetchError: error ? errMsg(error) : null };
  }, [data, error, loading, resources, metrics]);
}

/** values sampled at `from` timestamps, placed on the `to` axis (missing → null). */
export function alignTo(to: number[], from: number[], values: (number | null)[]): (number | null)[] {
  if (to === from || (to.length === from.length && to[0] === from[0])) return values;
  const idx = new Map(from.map((ts, i) => [ts, i]));
  return to.map((ts) => { const i = idx.get(ts); return i === undefined ? null : values[i] ?? null; });
}

export function MetricChart({ title, resources, metrics, timeframe, height = 160, showLegend = true, headless = false }: {
  title: string; resources: MetricResource[]; metrics: MetricName[]; timeframe: Timeframe; height?: number; showLegend?: boolean; headless?: boolean;
}) {
  const { t, series, errors, loading, fetchError } = useMetricSeries(resources, metrics, timeframe);
  const unit = METRIC_UNIT[metrics[0]];
  const shown = series.slice(0, MAX_SERIES);
  const message = fetchError ? `Could not load history: ${fetchError}`
    : !resources.length ? 'Nothing selected to plot.'
      : errors.length && !series.length ? `No history: ${errors.join('; ')}` : null;
  return (
    <div className="chart-card">
      {!headless && (
        <div className="chart-head">
          <span className="w-title">{title}</span>
          {showLegend && <Legend series={shown} />}
        </div>
      )}
      {headless && showLegend && <Legend series={shown} />}
      <LineChart title={title} t={t} series={shown} unit={unit} timeframe={timeframe} height={height} busy={loading} message={message} />
      {series.length > MAX_SERIES && <div className="ws">Showing the first {MAX_SERIES} of {series.length} series. Pick fewer resources to see the rest.</div>}
      {errors.length > 0 && series.length > 0 && <div className="ws">No history for {errors.join('; ')}</div>}
    </div>
  );
}
