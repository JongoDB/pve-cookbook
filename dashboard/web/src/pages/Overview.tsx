import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { MetricKind, Timeframe } from '../api/types';
import { useApp, useCrumbs } from '../state/app';
import {
  CATALOG, catalogEntry, defaultLayout, layoutReducer, METRIC_PRESETS, TIMEFRAMES,
  type Layout, type MetricConfig, type MetricPreset, type Widget, type WidgetCategory,
} from '../lib/layout';
import { LayoutPersistence } from '../lib/layoutStore';
import { TIMEFRAME_LABEL } from '../lib/chart';
import { storageKey } from '../lib/links';
import { IconClose, IconDown, IconResize, IconSettings, IconUp } from '../components/Icons';
import {
  AttentionWidget, BackupsWidget, CephWidget, ChangesWidget, GuestsWidget, MetricWidget, QuorumWidget, StorageWidget,
  GpuWidget, TasksWidget, TopGuestsWidget, cephTitle, resolveMetric, uniqueStorage, type WidgetHead,
} from './overview/Widgets';

export function TimeRange({ value, onChange }: { value: Timeframe; onChange: (t: Timeframe) => void }) {
  return (
    <div className="seg" role="group" aria-label="Time range for charts">
      {TIMEFRAMES.map((t) => (
        <button key={t} type="button" aria-pressed={value === t} onClick={() => onChange(t)}>{TIMEFRAME_LABEL[t]}</button>
      ))}
    </div>
  );
}

export function Overview() {
  useCrumbs([{ label: 'Overview' }]);
  const { api, fleet, guests, guestsError, me, clusterName } = useApp();
  const [layout, dispatch] = useReducer(layoutReducer, null, defaultLayout);
  const [loaded, setLoaded] = useState(false);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [announce, setAnnounce] = useState('');
  const persist = useRef<LayoutPersistence | null>(null);
  const lastSaved = useRef<string>('');

  useEffect(() => {
    const p = new LayoutPersistence(api, setSaveErr);
    persist.current = p;
    let alive = true;
    void p.load().then((r) => {
      if (!alive) return;
      lastSaved.current = JSON.stringify(r.layout);
      dispatch({ type: 'load', layout: r.layout });
      setLoadErr(r.error ?? null);
      setLoaded(true);
    });
    return () => { alive = false; p.dispose(); };
  }, [api]);

  // Save every change after the first load (debounced in LayoutPersistence).
  useEffect(() => {
    if (!loaded) return;
    const s = JSON.stringify(layout);
    if (s === lastSaved.current) return;
    lastSaved.current = s;
    persist.current?.save(layout);
  }, [layout, loaded]);

  const authed = (id: string) => !!me.clusters.find((c) => c.id === id)?.authed;
  const ctx = { fleet, guests, authed, clusterName };

  const title = (w: Widget): WidgetHead => {
    switch (w.type) {
      case 'quorum': return { title: 'Quorum', sub: fleet ? `${fleet.totals.clusters} cluster${fleet.totals.clusters === 1 ? '' : 's'}` : undefined };
      case 'ceph': return cephTitle(fleet);
      case 'backups': return { title: 'Backup coverage' };
      case 'guests': return { title: 'Guests' };
      case 'attention': return { title: 'Needs attention', sub: fleet ? `${fleet.findings.length} finding${fleet.findings.length === 1 ? '' : 's'}` : undefined };
      case 'storage': return { title: 'Storage capacity' };
      case 'topGuests': return { title: 'Top guests by CPU', sub: 'now' };
      case 'changes': return { title: 'Recent changes' };
      case 'tasks': return { title: 'Running tasks' };
      case 'gpus': return { title: 'GPUs', sub: 'PCI mappings' };
      case 'metric': {
        const r = resolveMetric(w.config!, ctx);
        return { title: r.title, sub: r.sub };
      }
    }
  };

  const body = (w: Widget) => {
    if (w.type === 'changes') return <ChangesWidget />;
    if (w.type === 'tasks') return <TasksWidget />;
    if (w.type === 'gpus') return <GpuWidget />;
    if (w.type === 'topGuests') return <TopGuestsWidget guests={guests} error={guestsError} />;
    if (w.type === 'metric') {
      if (configuring === w.id) return <MetricConfigForm cfg={w.config!} onCancel={() => setConfiguring(null)} onSave={(c) => { dispatch({ type: 'configure', id: w.id, config: c }); setConfiguring(null); }} />;
      return <MetricWidget resolved={resolveMetric(w.config!, ctx)} cfg={w.config!} timeframe={layout.timeframe} />;
    }
    if (!fleet) return <div className="ws" role="status">Loading cluster state</div>;
    switch (w.type) {
      case 'quorum': return <QuorumWidget fleet={fleet} />;
      case 'ceph': return <CephWidget fleet={fleet} />;
      case 'backups': return <BackupsWidget fleet={fleet} guests={guests} />;
      case 'guests': return <GuestsWidget fleet={fleet} />;
      case 'attention': return <AttentionWidget fleet={fleet} />;
      case 'storage': return <StorageWidget fleet={fleet} />;
    }
  };

  const names = (w: Widget) => title(w).title;
  const say = (msg: string) => setAnnounce(msg);
  const moveBy = (w: Widget, delta: -1 | 1) => {
    const i = layout.widgets.findIndex((x) => x.id === w.id);
    dispatch({ type: 'moveBy', id: w.id, delta });
    say(`${names(w)} moved to position ${Math.max(1, Math.min(layout.widgets.length, i + 1 + delta))} of ${layout.widgets.length}`);
  };

  const onDrop = (target: Widget, after: boolean) => {
    if (!dragId || dragId === target.id) return;
    const from = layout.widgets.findIndex((x) => x.id === dragId);
    let to = layout.widgets.findIndex((x) => x.id === target.id) + (after ? 1 : 0);
    if (from < to) to -= 1;
    dispatch({ type: 'move', id: dragId, to });
    const moved = layout.widgets[from];
    if (moved) say(`${names(moved)} moved to position ${to + 1} of ${layout.widgets.length}`);
  };

  return (
    <div className="page">
      <div className="ov-bar">
        <h1>Overview</h1>
        <TimeRange value={layout.timeframe} onChange={(t) => dispatch({ type: 'timeframe', timeframe: t })} />
        {editing ? (
          <>
            <button type="button" className="btn" onClick={() => { dispatch({ type: 'reset' }); say('Layout reset to the default'); }}>Reset to default</button>
            <button type="button" className="btn btn-primary" onClick={() => { setEditing(false); setConfiguring(null); void persist.current?.flush(); }}>Done</button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => setEditing(true)} disabled={!loaded}>Edit layout</button>
        )}
      </div>
      {loadErr && <div className="notice notice-warn" role="status"><div className="grow">{loadErr}</div></div>}
      {saveErr && <div className="notice notice-error" role="alert"><div className="grow">{saveErr} Your changes stay on this page until you reload.</div></div>}
      <div className="sr-only" aria-live="polite">{announce}</div>

      <div className="ov-wrap">
        <div className="grid" aria-busy={!loaded}>
          {layout.widgets.length === 0 && (
            <div className="w" style={{ gridColumn: 'span 12' }}>
              <div className="empty"><strong>The dashboard is empty</strong><div className="muted">Choose Edit layout and add widgets from the catalog, or reset to the default.</div></div>
            </div>
          )}
          {layout.widgets.map((w, i) => {
            const head = title(w);
            const hid = `wt-${w.id}`;
            const cls = ['w', `s-${w.span}`, editing ? 'editing' : '', dragId === w.id ? 'dragging' : '',
              drop?.id === w.id ? (drop.after ? 'drop-after' : 'drop-before') : ''].filter(Boolean).join(' ');
            return (
              <section
                key={w.id}
                className={cls}
                style={{ ['--span' as string]: w.span }}
                aria-labelledby={hid}
                draggable={editing && configuring !== w.id}
                onDragStart={(e) => { if (!editing) return; setDragId(w.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', w.id); }}
                onDragEnd={() => { setDragId(null); setDrop(null); }}
                onDragOver={(e) => {
                  if (!dragId || dragId === w.id) return;
                  e.preventDefault();
                  const r = e.currentTarget.getBoundingClientRect();
                  const after = e.clientX > r.left + r.width / 2;
                  if (drop?.id !== w.id || drop.after !== after) setDrop({ id: w.id, after });
                }}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrop((d) => (d?.id === w.id ? null : d)); }}
                onDrop={(e) => { e.preventDefault(); onDrop(w, drop?.after ?? false); setDrop(null); setDragId(null); }}
              >
                {editing && (
                  <div className="w-tools" role="toolbar" aria-label={`Arrange ${head.title}`}>
                    <button type="button" className="icon-btn outlined" aria-label={`Move ${head.title} earlier`} disabled={i === 0} onClick={() => moveBy(w, -1)}><IconUp /></button>
                    <button type="button" className="icon-btn outlined" aria-label={`Move ${head.title} later`} disabled={i === layout.widgets.length - 1} onClick={() => moveBy(w, 1)}><IconDown /></button>
                    <button type="button" className="icon-btn outlined" aria-label={`Change width of ${head.title}, now ${w.span} of 12 columns`}
                      onClick={() => { dispatch({ type: 'resize', id: w.id }); say(`${head.title} width changed`); }}><IconResize /></button>
                    <span className="span-label" aria-hidden="true">{w.span} of 12</span>
                    <span className="spacer" />
                    {w.type === 'metric' && (
                      <button type="button" className="icon-btn outlined" aria-label={`Choose what ${head.title} shows`} aria-expanded={configuring === w.id}
                        onClick={() => setConfiguring((c) => (c === w.id ? null : w.id))}><IconSettings /></button>
                    )}
                    <button type="button" className="icon-btn outlined" aria-label={`Remove ${head.title}`}
                      onClick={() => { dispatch({ type: 'remove', id: w.id }); say(`${head.title} removed`); }}><IconClose /></button>
                  </div>
                )}
                <div className="w-head">
                  <h2 className="w-title" id={hid}>{head.title}</h2>
                  {head.sub !== undefined && <span className="w-sub">{head.sub}</span>}
                </div>
                {body(w)}
              </section>
            );
          })}
        </div>
        {editing && <Catalog layout={layout} onAdd={(t) => { dispatch({ type: 'add', widget: t }); say(`${catalogEntry(t).title} added at the end`); }} />}
      </div>
    </div>
  );
}

const CATEGORIES: (WidgetCategory | 'All')[] = ['All', 'Health', 'Capacity', 'Performance', 'Protection', 'Activity'];

function Catalog({ layout, onAdd }: { layout: Layout; onAdd: (t: Widget['type']) => void }) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<WidgetCategory | 'All'>('All');
  const items = CATALOG.filter((c) => (cat === 'All' || c.category === cat) && (!q || `${c.title} ${c.description}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <aside className="catalog" aria-label="Add a widget">
      <h2>Add a widget</h2>
      <label className="sr-only" htmlFor="cat-search">Search widgets</label>
      <input id="cat-search" type="search" placeholder="Search widgets" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="chips" role="group" aria-label="Category">
        {CATEGORIES.map((c) => <button key={c} type="button" className="chip" aria-pressed={cat === c} onClick={() => setCat(c)}>{c}</button>)}
      </div>
      {items.length === 0 && <p className="muted">No widget matches. Clear the search or pick another category.</p>}
      {items.map((c) => {
        const present = !c.multiple && layout.widgets.some((w) => w.type === c.type);
        return (
          <div className="ci" key={c.type}>
            <div><div className="t">{c.title}</div><div className="d">{c.description}</div></div>
            <button type="button" className="btn btn-sm" disabled={present} onClick={() => onAdd(c.type)} aria-label={present ? `${c.title} is on the dashboard` : `Add ${c.title}`}>
              {present ? 'Added' : 'Add'}
            </button>
          </div>
        );
      })}
    </aside>
  );
}

function MetricConfigForm({ cfg, onSave, onCancel }: { cfg: MetricConfig; onSave: (c: MetricConfig) => void; onCancel: () => void }) {
  const { fleet, guests, me, clusterName } = useApp();
  const authedClusters = me.clusters.filter((c) => c.authed);
  const [c, setC] = useState<MetricConfig>({ ...cfg, cluster: cfg.cluster || authedClusters[0]?.id || '' });
  const summary = fleet?.clusters.find((x) => x.id === c.cluster);
  const presets = (Object.keys(METRIC_PRESETS) as MetricPreset[]).filter((p) => METRIC_PRESETS[p].kinds.includes(c.kind));
  const options = useMemo(() => {
    if (c.kind === 'node') return (summary?.nodes ?? []).map((n) => ({ id: n.name, label: n.name }));
    if (c.kind === 'guest') return (guests ?? []).filter((g) => g.clusterId === c.cluster && !g.template).sort((a, b) => a.vmid - b.vmid).map((g) => ({ id: String(g.vmid), label: `${g.name} (${g.vmid})` }));
    if (c.kind === 'storage') return summary ? uniqueStorage(summary).map((s) => ({ id: storageKey(s.id, s.node, s.shared), label: s.shared ? s.id : `${s.id} on ${s.node}` })) : [];
    return [];
  }, [c.kind, c.cluster, summary, guests]);
  const setKind = (kind: MetricKind) => setC((x) => ({
    ...x, kind, ids: kind === 'cluster' ? [''] : [],
    metric: METRIC_PRESETS[x.metric].kinds.includes(kind) ? x.metric : (Object.keys(METRIC_PRESETS) as MetricPreset[]).find((p) => METRIC_PRESETS[p].kinds.includes(kind))!,
  }));
  const toggle = (id: string) => setC((x) => ({ ...x, ids: x.ids.includes(id) ? x.ids.filter((y) => y !== id) : [...x.ids, id] }));
  const idp = 'mc';
  return (
    <form className="form-stack" onSubmit={(e) => { e.preventDefault(); onSave(c); }} aria-label="Chart settings">
      <div className="form-row">
        <label className="field"><span className="label">Title</span>
          <input value={c.title ?? ''} placeholder="Automatic" onChange={(e) => setC({ ...c, title: e.target.value || undefined })} maxLength={80} />
        </label>
        <label className="field"><span className="label">Cluster</span>
          <select value={c.cluster} onChange={(e) => setC({ ...c, cluster: e.target.value, ids: c.kind === 'cluster' ? [''] : [] })}>
            {authedClusters.map((x) => <option key={x.id} value={x.id}>{clusterName(x.id)}</option>)}
          </select>
        </label>
      </div>
      <div className="form-row">
        <label className="field"><span className="label">Show</span>
          <select value={c.kind} onChange={(e) => setKind(e.target.value as MetricKind)}>
            <option value="cluster">Whole cluster</option><option value="node">Nodes</option><option value="guest">Guests</option><option value="storage">Storage</option>
          </select>
        </label>
        <label className="field"><span className="label">Metric</span>
          <select value={c.metric} onChange={(e) => setC({ ...c, metric: e.target.value as MetricPreset })}>
            {presets.map((p) => <option key={p} value={p}>{METRIC_PRESETS[p].label}</option>)}
          </select>
        </label>
      </div>
      {c.kind !== 'cluster' && (
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 6 }}>{c.kind === 'node' ? 'Nodes (none selected: every online node)' : c.kind === 'guest' ? 'Guests' : 'Storage'}</legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', maxHeight: 150, overflowY: 'auto' }}>
            {options.length === 0 && <span className="muted">Nothing to choose on this cluster.</span>}
            {options.map((o) => (
              <label key={o.id} className="check" htmlFor={`${idp}-${o.id}`}>
                <input id={`${idp}-${o.id}`} type="checkbox" checked={c.ids.includes(o.id)} onChange={() => toggle(o.id)} />{o.label}
              </label>
            ))}
          </div>
          {c.ids.length * METRIC_PRESETS[c.metric].series.length > 5 && <span className="hint">A chart shows at most five lines; pick fewer to see them all.</span>}
        </fieldset>
      )}
      <div className="row-actions">
        <button type="submit" className="btn btn-primary btn-sm">Save chart</button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
