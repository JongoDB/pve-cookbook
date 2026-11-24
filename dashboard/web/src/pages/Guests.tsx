import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Guest, GuestTarget } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { Empty, ErrorBox, Meter, Status } from '../components/ui';
import { uptime } from '../lib/format';
import { formatBytes, formatPct } from '../lib/units';
import { guestPath, nodePath } from '../lib/links';
import type { GuestAction } from '../lib/actions';
import { guestTone } from './GuestDetail';

const key = (g: Guest) => `${g.clusterId}:${g.vmid}`;

type Mode = null | 'snapshot' | 'migrate';

const POWER: [GuestAction, string][] = [
  ['guest.start', 'Start'], ['guest.shutdown', 'Shut down'], ['guest.reboot', 'Reboot'], ['guest.stop', 'Stop'],
];

export function Guests() {
  useCrumbs([{ label: 'Guests' }]);
  const { api, fleet, openPlan, clusterName, me, guests, guestsError } = useApp();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const cluster = params.get('cluster') ?? '';
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<Mode>(null);
  const [snapName, setSnapName] = useState('');
  const [targets, setTargets] = useState<string[] | null>(null);
  const [target, setTarget] = useState('');

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
  const multi = me.clusters.length > 1;

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
    } catch (e) { setErr(`Could not list migration targets: ${errMsg(e)}`); setMode(null); }
  };

  const disabledWhy = selected.length === 0 ? 'Select guests first'
    : !oneCluster ? 'Select guests from one cluster at a time'
      : !authed ? `Log in to ${clusterName(oneCluster)} first` : '';
  const total = (guests ?? []).filter((g) => !g.template).length;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Guests</h1>
        <div className="sub">{guests ? `${rows.length} of ${total} guests${fleet && multi ? ` on ${fleet.totals.clusters} clusters` : ''}` : ''}</div>
      </div>

      <div className="filters">
        <label className="field grow"><span className="sr-only">Search guests</span>
          <input type="search" placeholder="Search name, VMID, tag or node" value={q} onChange={(e) => setParam('q', e.target.value)} />
        </label>
        {multi && (
          <label className="field inline"><span className="label">Cluster</span>
            <select value={cluster} onChange={(e) => setParam('cluster', e.target.value)}>
              <option value="">All</option>
              {me.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label className="field inline"><span className="label">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Any</option><option value="running">Running</option><option value="stopped">Stopped</option><option value="paused">Paused</option>
          </select>
        </label>
        <label className="field inline"><span className="label">Type</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">VMs and containers</option><option value="qemu">VMs</option><option value="lxc">Containers</option>
          </select>
        </label>
      </div>

      <div className="toolbar" role="toolbar" aria-label="Actions for selected guests">
        <span className="muted" aria-live="polite">{selected.length ? `${selected.length} selected` : 'Select guests to act on several at once'}</span>
        <span className="spacer" />
        {POWER.map(([a, label]) => (
          <button key={a} type="button" className="btn btn-sm" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={() => plan(a)}>{label}</button>
        ))}
        <button type="button" className="btn btn-sm" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={() => { setMode('snapshot'); setSnapName(''); }}>Snapshot</button>
        <button type="button" className="btn btn-sm" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={startMigrate}>Migrate</button>
        <button type="button" className="btn btn-sm btn-danger-outline" disabled={!!disabledWhy} title={disabledWhy || undefined} onClick={() => plan('guest.destroy')}>Destroy</button>
      </div>
      {disabledWhy && selected.length > 0 && <div className="notice notice-warn" role="status"><div className="grow">{disabledWhy}{!authed && oneCluster ? <> on the <Link to={`/clusters#${oneCluster}`}>Clusters page</Link>.</> : '.'}</div></div>}

      {mode === 'snapshot' && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); plan('guest.snapshot', { name: snapName }); }}>
          <label className="field"><span className="label">Snapshot name</span>
            <input value={snapName} onChange={(e) => setSnapName(e.target.value)} pattern="[A-Za-z][A-Za-z0-9_\-]{1,39}" placeholder="pre-upgrade" required autoFocus />
          </label>
          <button type="submit" className="btn btn-primary">Review snapshot</button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
        </form>
      )}
      {mode === 'migrate' && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (target) plan('guest.migrate', { target, online: true }); }}>
          <label className="field"><span className="label">Target node</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!targets?.length}>
              {targets === null && <option>Loading nodes</option>}
              {targets?.length === 0 && <option value="">No node can take every selected guest</option>}
              {targets?.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={!target}>Review migration</button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
          <span className="muted small" style={{ flexBasis: '100%' }}>Running VMs move live; containers restart on the target.</span>
        </form>
      )}

      <ErrorBox message={err} />
      {guestsError && !guests && <ErrorBox message={`Could not load guests: ${guestsError}`} />}

      <section className="panel" aria-label="Guest list">
        {guests === null ? <div className="muted panel-body" role="status">Loading guests</div> : rows.length === 0 ? <Empty title="No guests match">Clear the search or filters.</Empty> : (
          <div className="table-wrap">
            <table className="table dense">
              <thead>
                <tr>
                  <th scope="col"><input type="checkbox" aria-label="Select all shown guests" checked={allChecked} onChange={toggleAll} /></th>
                  <th scope="col">VMID</th><th scope="col">Name</th><th scope="col">Type</th>{multi && <th scope="col">Cluster</th>}<th scope="col">Node</th>
                  <th scope="col">Status</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Up for</th><th scope="col">Tags</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((g) => (
                  <tr key={key(g)} className={sel.has(key(g)) ? 'selected' : ''}>
                    <td><input type="checkbox" aria-label={`Select ${g.name} (${g.vmid})`} checked={sel.has(key(g))} onChange={() => toggle(g)} /></td>
                    <td className="num">{g.vmid}</td>
                    <td className="strong"><Link to={guestPath(g.clusterId, g.vmid)}>{g.name}</Link>{g.hastate ? <span className="badge badge-info" style={{ marginLeft: 8 }} title={`HA state: ${g.hastate}`}>HA</span> : null}</td>
                    <td className="text-2">{g.type === 'qemu' ? 'VM' : 'Container'}</td>
                    {multi && <td className="text-2">{clusterName(g.clusterId)}</td>}
                    <td><Link to={nodePath(g.clusterId, g.node)}>{g.node}</Link></td>
                    <td><Status tone={guestTone(g.status)}>{g.status}</Status></td>
                    <td style={{ minWidth: 130 }}>{g.status === 'running' ? <Meter used={g.cpu} total={1} label={`${g.name} CPU`} text={formatPct(g.cpu)} fixed /> : ''}</td>
                    <td className="num nowrap">{g.status === 'running' ? `${formatBytes(g.mem)} of ${formatBytes(g.maxmem)}` : <span className="muted">{formatBytes(g.maxmem)}</span>}</td>
                    <td className="text-2 nowrap">{g.status === 'running' ? uptime(g.uptime) : ''}</td>
                    <td>{g.tags.map((t) => <button key={t} type="button" className="tag" onClick={() => setParam('q', t)} aria-label={`Filter by tag ${t}`}>{t}</button>)}</td>
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
