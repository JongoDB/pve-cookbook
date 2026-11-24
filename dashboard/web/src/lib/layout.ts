// Overview dashboard layout: a list of widgets on a 12-column grid, plus the shared time range.
// Pure (reducer + helpers) so it can be unit-tested; persisted per user via /api/prefs/dashboard.
import type { MetricKind, MetricName, Timeframe } from '../api/types';

export type Span = 3 | 4 | 6 | 8 | 12;
export const SPANS: Span[] = [3, 4, 6, 8, 12];

export type WidgetType =
  | 'quorum' | 'ceph' | 'backups' | 'guests' | 'attention' | 'metric' | 'storage' | 'topGuests' | 'changes' | 'tasks';

/** A metric preset: which normalized series a chart plots. */
export type MetricPreset = 'cpu' | 'memory' | 'network' | 'diskIo' | 'load' | 'ioWait' | 'pressure' | 'swap' | 'rootfs' | 'storage';

export const METRIC_PRESETS: Record<MetricPreset, { label: string; series: MetricName[]; kinds: MetricKind[] }> = {
  cpu: { label: 'CPU', series: ['cpu'], kinds: ['cluster', 'node', 'guest'] },
  memory: { label: 'Memory used', series: ['memUsed'], kinds: ['cluster', 'node', 'guest'] },
  network: { label: 'Network', series: ['netIn', 'netOut'], kinds: ['cluster', 'node', 'guest'] },
  diskIo: { label: 'Disk I/O', series: ['diskRead', 'diskWrite'], kinds: ['guest'] },
  load: { label: 'Load average', series: ['load'], kinds: ['cluster', 'node'] },
  ioWait: { label: 'IO wait', series: ['ioWait'], kinds: ['cluster', 'node'] },
  pressure: { label: 'Pressure (PSI)', series: ['pressureCpu', 'pressureIo', 'pressureMem'], kinds: ['cluster', 'node', 'guest'] },
  swap: { label: 'Swap used', series: ['swapUsed'], kinds: ['cluster', 'node', 'guest'] },
  rootfs: { label: 'Root disk used', series: ['rootUsed'], kinds: ['cluster', 'node'] },
  storage: { label: 'Storage used', series: ['diskUsed'], kinds: ['storage'] },
};

export interface MetricConfig {
  kind: MetricKind;
  /** "" = the first cluster you are logged in to */
  cluster: string;
  /** node names, vmids, storage[@node]; empty = every node of the cluster (kind node) */
  ids: string[];
  metric: MetricPreset;
  title?: string;
}

export interface Widget { id: string; type: WidgetType; span: Span; config?: MetricConfig }

export interface Layout { version: 1; timeframe: Timeframe; widgets: Widget[] }

export type WidgetCategory = 'Health' | 'Capacity' | 'Performance' | 'Protection' | 'Activity';

export interface CatalogEntry { type: WidgetType; title: string; description: string; category: WidgetCategory; span: Span; multiple?: boolean }

export const CATALOG: CatalogEntry[] = [
  { type: 'metric', title: 'Metric chart', description: 'Any metric of any cluster, node, guest or storage: CPU, memory, network, disk I/O, pressure.', category: 'Performance', span: 8, multiple: true },
  { type: 'quorum', title: 'Quorum', description: 'Nodes online and whether each cluster is quorate.', category: 'Health', span: 3 },
  { type: 'ceph', title: 'Ceph', description: 'Health, OSDs and raw capacity for each cluster that runs Ceph.', category: 'Health', span: 3 },
  { type: 'attention', title: 'Needs attention', description: 'Health and drift findings. Findings with a fix open as a change.', category: 'Health', span: 4 },
  { type: 'backups', title: 'Backup coverage', description: 'Guests in a backup job, and which ones are not.', category: 'Protection', span: 3 },
  { type: 'guests', title: 'Guests', description: 'Running and total guests across clusters.', category: 'Capacity', span: 3 },
  { type: 'storage', title: 'Storage capacity', description: 'Used and free space per storage.', category: 'Capacity', span: 6 },
  { type: 'topGuests', title: 'Top guests by CPU', description: 'The busiest guests right now.', category: 'Performance', span: 4 },
  { type: 'changes', title: 'Recent changes', description: 'Latest entries in the audit log, with who ran them.', category: 'Activity', span: 6 },
  { type: 'tasks', title: 'Running tasks', description: 'Live PVE tasks across clusters.', category: 'Activity', span: 6 },
];

export const catalogEntry = (t: WidgetType) => CATALOG.find((c) => c.type === t)!;

export const TIMEFRAMES: Timeframe[] = ['hour', 'day', 'week', 'month', 'year'];

export function defaultLayout(): Layout {
  return {
    version: 1,
    timeframe: 'day',
    widgets: [
      { id: 'quorum', type: 'quorum', span: 3 },
      { id: 'ceph', type: 'ceph', span: 3 },
      { id: 'backups', type: 'backups', span: 3 },
      { id: 'guests', type: 'guests', span: 3 },
      { id: 'node-cpu', type: 'metric', span: 8, config: { kind: 'node', cluster: '', ids: [], metric: 'cpu' } },
      { id: 'attention', type: 'attention', span: 4 },
      { id: 'cluster-net', type: 'metric', span: 8, config: { kind: 'cluster', cluster: '', ids: [''], metric: 'network' } },
      { id: 'top-guests', type: 'topGuests', span: 4 },
      { id: 'storage', type: 'storage', span: 6 },
      { id: 'changes', type: 'changes', span: 6 },
    ],
  };
}

export type LayoutAction =
  | { type: 'add'; widget: WidgetType; id?: string; config?: MetricConfig }
  | { type: 'remove'; id: string }
  /** move to an absolute index (drag and drop) */
  | { type: 'move'; id: string; to: number }
  /** move one place earlier (-1) or later (+1) (keyboard) */
  | { type: 'moveBy'; id: string; delta: -1 | 1 }
  /** cycle 3 → 4 → 6 → 8 → 12 → 3 */
  | { type: 'resize'; id: string }
  | { type: 'configure'; id: string; config: MetricConfig }
  | { type: 'timeframe'; timeframe: Timeframe }
  | { type: 'reset' }
  | { type: 'load'; layout: Layout };

export const nextSpan = (s: Span): Span => SPANS[(SPANS.indexOf(s) + 1) % SPANS.length] ?? 3;

let seq = 0;
const newId = (t: WidgetType) => `${t}-${Date.now().toString(36)}${(seq++).toString(36)}`;

export function layoutReducer(state: Layout, a: LayoutAction): Layout {
  const ws = state.widgets;
  switch (a.type) {
    case 'add': {
      const entry = catalogEntry(a.widget);
      if (!entry || (!entry.multiple && ws.some((w) => w.type === a.widget))) return state;
      const config = a.config ?? (a.widget === 'metric' ? { kind: 'node', cluster: '', ids: [], metric: 'cpu' } as MetricConfig : undefined);
      const w: Widget = { id: a.id ?? newId(a.widget), type: a.widget, span: entry.span, ...(config ? { config } : {}) };
      return { ...state, widgets: [...ws, w] };
    }
    case 'remove':
      return { ...state, widgets: ws.filter((w) => w.id !== a.id) };
    case 'move': {
      const from = ws.findIndex((w) => w.id === a.id);
      if (from < 0) return state;
      const to = Math.max(0, Math.min(ws.length - 1, a.to));
      if (to === from) return state;
      const next = ws.slice();
      const [w] = next.splice(from, 1);
      next.splice(to, 0, w);
      return { ...state, widgets: next };
    }
    case 'moveBy': {
      const from = ws.findIndex((w) => w.id === a.id);
      return from < 0 ? state : layoutReducer(state, { type: 'move', id: a.id, to: from + a.delta });
    }
    case 'resize':
      return { ...state, widgets: ws.map((w) => (w.id === a.id ? { ...w, span: nextSpan(w.span) } : w)) };
    case 'configure':
      return { ...state, widgets: ws.map((w) => (w.id === a.id ? { ...w, config: a.config } : w)) };
    case 'timeframe':
      return state.timeframe === a.timeframe ? state : { ...state, timeframe: a.timeframe };
    case 'reset':
      return { ...defaultLayout(), timeframe: state.timeframe };
    case 'load':
      return a.layout;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const WIDGET_TYPES = new Set<string>(CATALOG.map((c) => c.type));
const KINDS = new Set(['cluster', 'node', 'guest', 'storage']);

/** Accept a stored layout only in a shape this build understands; drop unknown widgets. */
export function sanitizeLayout(v: unknown): Layout | null {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.widgets)) return null;
  const timeframe = TIMEFRAMES.includes(v.timeframe as Timeframe) ? (v.timeframe as Timeframe) : 'day';
  const seen = new Set<string>();
  const widgets: Widget[] = [];
  for (const w of v.widgets) {
    if (!isObj(w) || typeof w.id !== 'string' || seen.has(w.id) || !WIDGET_TYPES.has(w.type as string)) continue;
    const span = SPANS.includes(w.span as Span) ? (w.span as Span) : catalogEntry(w.type as WidgetType).span;
    let config: MetricConfig | undefined;
    if (w.type === 'metric') {
      const c = isObj(w.config) ? w.config : {};
      config = {
        kind: KINDS.has(c.kind as string) ? (c.kind as MetricKind) : 'node',
        cluster: typeof c.cluster === 'string' ? c.cluster : '',
        ids: Array.isArray(c.ids) ? c.ids.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
        metric: (c.metric as string) in METRIC_PRESETS ? (c.metric as MetricPreset) : 'cpu',
        ...(typeof c.title === 'string' && c.title ? { title: c.title.slice(0, 80) } : {}),
      };
    }
    seen.add(w.id);
    widgets.push({ id: w.id, type: w.type as WidgetType, span, ...(config ? { config } : {}) });
  }
  return { version: 1, timeframe, widgets };
}
