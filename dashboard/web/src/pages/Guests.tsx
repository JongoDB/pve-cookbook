import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Guest, GuestTarget } from '../api/types';
import { errMsg, useApp } from '../state/app';
import { Bar, Dot, Empty, ErrorBox } from '../components/ui';
import { bytes, uptime } from '../lib/format';
import type { GuestAction } from '../lib/actions';

const key = (g: Guest) => `${g.clusterId}:${g.vmid}`;
/** Fleet ticks arrive every few seconds; the guest list refetches at most this often on them. */
const GUEST_REFRESH_MS = 15_000;
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';

const statusTone = (s: string) => (s === 'running' ? 'ok' : s === 'paused' ? 'warn' : 'off');

type Mode = null | 'snapshot' | 'migrate';

const POWER: [GuestAction, string][] = [
  ['guest.start', 'Start'], ['guest.shutdown', 'Shut down'], ['guest.reboot', 'Reboot'], ['guest.stop', 'Stop'],
];

export function Guests() {
  const { api, fleet, openPlan, clusterName, me, lastAudit } = useApp();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const cluster = params.get('cluster') ?? '';
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>(null);
  const [snapName, setSnapName] = useState('');
  const [targets, setTargets] = useState<string[] | null>(null);
  const [target, setTarget] = useState('');

  // Keep the table live without hammering the API: refetch on fleet ticks at most every 15 s,
  // immediately when filters change or a plan ran, and never while the tab is hidden.
  const lastFetch = useRef(0);
  const seq = useRef(0);
  const refetch = useCallback((force: boolean) => {
    if (hidden()) return;
    if (!force && Date.now() - lastFetch.current < GUEST_REFRESH_MS) return;
    lastFetch.current = Date.now();
    const n = ++seq.current;
    api.guests()
      .then((g) => { if (n === seq.current) { setGuests(g); setErr(null); } })
      .catch((e) => { if (n === seq.current) setErr(errMsg(e)); });
  }, [api]);

  useEffect(() => () => { seq.current++; }, []);
  // (the search box filters client-side, so typing does not refetch)
  useEffect(() => { refetch(true); }, [refetch, cluster, status, type, lastAudit?.id, lastAudit?.status]);
  useEffect(() => { refetch(false); }, [refetch, fleet?.updatedAt]);
  useEffect(() => {
    const onVis = () => { if (!hidden()) refetch(false); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refetch]);

  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v); else p.delete(k);
    setParams(p, { replace: true });
  };

  const rows = useMemo(() => {
    const ql = q.toLowerCase();
    return (guests ?? [])
      .filter((g) => !g.template)
      .filter((g) => (!cluster || g.clusterId === cluster) && (!status || g.status === status) && (!type || g.type === type))
      .filter((g) => !ql || g.name.toLowerCase().includes(ql) || String(g.vmid).includes(ql) || g.tags.some((t) => t.toLowerCase().includes(ql)) || g.node.includes(ql))
      .sort((a, b) => a.clusterId.localeCompare(b.clusterId) || a.vmid - b.vmid);
  }, [guests, q, cluster, status, type]);

  const selected = rows.filter((g) => sel.has(key(g)));
  const clusters = new Set(selected.map((g) => g.clusterId));
  const oneCluster = clusters.size === 1 ? [...clusters][0] : null;
  const authed = oneCluster ? me.clusters.find((c) => c.id === oneCluster)?.authed : false;
  const allChecked = rows.length > 0 && rows.every((g) => sel.has(key(g)));

  const toggle = (g: Guest) => setSel((s) => { const n = new Set(s); if (n.has(key(g))) n.delete(key(g)); else n.add(key(g)); return n; });
  const toggleAll = () => setSel(allChecked ? new Set() : new Set(rows.map(key)));
  const tgts = (): GuestTarget[] => selected.map((g) => ({ vmid: g.vmid, node: g.node, type: g.type }));

  const plan = (action: GuestAction, extra: Record<string, unknown> = {}) => {
    if (!oneCluster) return;
    void openPlan({ action, clusterId: oneCluster, params: { targets: tgts(), ...extra } });
    setMode(null);
  };

  const startMigrate = async () => {
    if (!oneCluster) return;
    setMode('migrate'); setTargets(null); setTarget('');
    try {
      const sources = [...new Set(selected.map((g) => g.node))];
      const lists = await Promise.all(sources.map((n) => api.targets(oneCluster, n)));
      const common = lists.reduce((a, l) => a.filter((x) => l.includes(x)));
      setTargets(common);
      setTarget(common[0] ?? '');
    } catch (e) { setErr(errMsg(e)); setMode(null); }
  };

  const disabledWhy = selected.length === 0 ? 'Select guests first'
    : !oneCluster ? 'Select guests from one cluster at a time'
      : !authed ? `Log in to ${clusterName(oneCluster)} first (Clusters page)` : '';

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Guests</h1>
          <div className="muted">{rows.length} of {(guests ?? []).filter((g) => !g.template).length} guests{fleet ? ` across ${fleet.totals.clusters} cluster${fleet.totals.clusters === 1 ? '' : 's'}` : ''}</div>
        </div>
      </div>

      <div className="filters">
        <label className="field inline grow"><span className="sr-only">Search guests</span>
          <input type="search" placeholder="Search name, VMID, tag or node" value={q} onChange={(e) => setParam('q', e.target.value)} />
        </label>
        <label className="field inline"><span>Cluster</span>
          <select value={cluster} onChange={(e) => setParam('cluster', e.target.value)}>
            <option value="">All</option>
            {me.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="field inline"><span>Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="paused">Paused</option>
          </select>
        </label>
        <label className="field inline"><span>Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">VMs &amp; CTs</option><option value="qemu">VMs</option><option value="lxc">Containers</option>
          </select>
        </label>
      </div>

      <div className="bulkbar" role="toolbar" aria-label="Bulk actions">
        <span className="muted">{selected.length ? `${selected.length} selected` : 'No selection'}</span>
        {POWER.map(([a, label]) => (
          <button key={a} type="button" className="btn btn-sm" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={() => plan(a)}>
            {label}
          </button>
        ))}
        <button type="button" className="btn btn-sm" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={() => { setMode('snapshot'); setSnapName(''); }}>Snapshot…</button>
        <button type="button" className="btn btn-sm" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={startMigrate}>Migrate…</button>
        <button type="button" className="btn btn-sm btn-danger-outline" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={() => plan('guest.destroy')}>Destroy…</button>
        {disabledWhy && selected.length > 0 && <span className="small tone-warn">{disabledWhy}</span>}
      </div>

      {mode === 'snapshot' && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); plan('guest.snapshot', { name: snapName }); }}>
          <label className="field inline"><span>Snapshot name</span>
            <input value={snapName} onChange={(e) => setSnapName(e.target.value)} pattern="[A-Za-z][A-Za-z0-9_\-]{1,39}" placeholder="pre-upgrade" required autoFocus />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">Plan snapshot</button>
          <button type="button" className="btn btn-sm" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === 'migrate' && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (target) plan('guest.migrate', { target, online: true }); }}>
          <label className="field inline"><span>Target node</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!targets?.length}>
              {targets === null && <option>Loading…</option>}
              {targets?.length === 0 && <option value="">No common target</option>}
              {targets?.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!target}>Plan migration</button>
          <button type="button" className="btn btn-sm" onClick={() => setMode(null)}>Cancel</button>
          <span className="muted small">Running VMs migrate live; containers restart on the target.</span>
        </form>
      )}

      <ErrorBox message={err} />

      <section className="panel" aria-label="Guest list">
        {guests === null ? <div className="muted pad">Loading guests…</div> : rows.length === 0 ? <Empty title="No guests match">Clear the search or filters.</Empty> : (
          <div className="table-box">
            <table className="table dense">
              <thead>
                <tr>
                  <th scope="col"><input type="checkbox" aria-label="Select all shown guests" checked={allChecked} onChange={toggleAll} /></th>
                  <th scope="col">VMID</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Cluster</th><th scope="col">Node</th>
                  <th scope="col">Status</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Uptime</th><th scope="col">Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={key(g)} className={sel.has(key(g)) ? 'row-sel' : ''}>
                    <td><input type="checkbox" aria-label={`Select ${g.name} (${g.vmid})`} checked={sel.has(key(g))} onChange={() => toggle(g)} /></td>
                    <td className="mono">{g.vmid}</td>
                    <td className="strong">{g.name}{g.hastate ? <span className="pill pill-ha" title={`HA: ${g.hastate}`}>HA</span> : null}</td>
                    <td className="muted">{g.type === 'qemu' ? 'VM' : 'CT'}</td>
                    <td className="muted">{clusterName(g.clusterId)}</td>
                    <td className="mono">{g.node}</td>
                    <td><Dot tone={statusTone(g.status)} /> {g.status}</td>
                    <td>
                      {g.status === 'running'
                        ? <span className="meter"><Bar used={g.cpu} total={1} label={`${g.name} CPU`} /><span className="mono small">{Math.round(g.cpu * 100)}%</span></span>
                        : <span className="muted">—</span>}
                    </td>
                    <td className="mono small">{g.status === 'running' ? `${bytes(g.mem)} / ${bytes(g.maxmem)}` : <span className="muted">{bytes(g.maxmem)}</span>}</td>
                    <td className="mono small muted">{uptime(g.uptime)}</td>
                    <td>{g.tags.map((t) => <button key={t} type="button" className="tag" onClick={() => setParam('q', t)}>{t}</button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
