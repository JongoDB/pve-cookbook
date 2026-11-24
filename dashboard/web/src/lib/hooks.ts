import { useCallback, useEffect, useRef, useState } from 'react';
import type { MetricQuery, MetricSeries, Timeframe } from '../api/types';
import { useApp } from '../state/app';
import { refreshMs } from './chart';

export interface AsyncState<T> { data: T | null; error: unknown; loading: boolean; reload: () => void }

/** Run an async load whenever `key` changes; stale answers are dropped. */
export function useAsync<T>(load: (() => Promise<T>) | null, key: string): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(!!load);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seq = useRef(0);
  const lastKey = useRef(key);

  useEffect(() => {
    const fn = loadRef.current;
    if (!fn) { setLoading(false); return; }
    const n = ++seq.current;
    if (lastKey.current !== key) { setData(null); lastKey.current = key; }
    setLoading(true);
    fn().then(
      (d) => { if (n === seq.current) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (n === seq.current) { setError(e); setLoading(false); } },
    );
  }, [key, tick]);
  useEffect(() => () => { seq.current++; }, []);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** A read through the user's own PVE session (GET /api/clusters/{id}/pve/{path}). */
export function usePve<T>(clusterId: string | null, path: string | null, query: Record<string, string | number | undefined> = {}, refreshKey = ''): AsyncState<T> {
  const { api, me } = useApp();
  const authed = !!me.clusters.find((c) => c.id === clusterId)?.authed;
  const qkey = JSON.stringify(query);
  const key = `${clusterId}|${path}|${qkey}|${authed}|${refreshKey}`;
  return useAsync<T>(clusterId && path ? () => api.pve<T>(clusterId, path, JSON.parse(qkey)) : null, key);
}

const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

/**
 * Metric history for a set of queries, refreshed at a rate that fits the timeframe
 * (hour 30 s, day 2 min, longer 10 min) and paused while the tab is hidden.
 * The previous data is kept while a refresh is in flight.
 */
export function useMetrics(queries: MetricQuery[], timeframe: Timeframe) {
  const { api } = useApp();
  const qs = queries.map((q) => ({ ...q, timeframe }));
  const key = JSON.stringify(qs);
  const [data, setData] = useState<MetricSeries[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const lastLoad = useRef(0);
  const lastKey = useRef('');

  const load = useCallback(async () => {
    const list = JSON.parse(key) as MetricQuery[];
    if (!list.length) { setData([]); return; }
    const n = ++seq.current;
    if (lastKey.current !== key) { lastKey.current = key; setData(null); }
    setLoading(true);
    lastLoad.current = Date.now();
    try {
      const chunks: MetricQuery[][] = [];
      for (let i = 0; i < list.length; i += 32) chunks.push(list.slice(i, i + 32));
      const res = (await Promise.all(chunks.map((c) => api.metricsBatch(c)))).flat();
      if (n === seq.current) { setData(res); setError(null); }
    } catch (e) {
      if (n === seq.current) setError(e);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [api, key]);

  useEffect(() => {
    void load();
    const every = refreshMs(timeframe);
    const counter = seq;
    const t = setInterval(() => { if (!isHidden()) void load(); }, every);
    const onVis = () => { if (!isHidden() && Date.now() - lastLoad.current >= every) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); counter.current++; };
  }, [load, timeframe]);

  return { data, error, loading, reload: load };
}
