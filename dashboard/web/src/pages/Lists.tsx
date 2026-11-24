// Nodes, Storage and Activity list pages: tables over the live fleet summary and task feed.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, useCrumbs } from '../state/app';
import { ago, clock, pctLabel, uptime } from '../lib/format';
import { formatBytes, formatPct } from '../lib/units';
import { nodePath, storageKey, storagePath } from '../lib/links';
import { Badge, Empty, Meter, Status } from '../components/ui';
import { storageUnavailable, staleReason, uniqueStorage } from './overview/Widgets';
import { taskBadge } from './GuestDetail';

function ClusterFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { me } = useApp();
  if (me.clusters.length < 2) return null;
  return (
    <label className="field inline"><span className="label">Cluster</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {me.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

export function Nodes() {
  useCrumbs([{ label: 'Nodes' }]);
  const { fleet } = useApp();
  const [cluster, setCluster] = useState('');
  const cs = (fleet?.clusters ?? []).filter((c) => !cluster || c.id === cluster);
  const rows = cs.flatMap((c) => c.nodes.map((n) => ({ c, n })));
  return (
    <div className="page">
      <div className="page-head"><h1>Nodes</h1><ClusterFilter value={cluster} onChange={setCluster} /></div>
      {cs.filter((c) => c.stale).map((c) => <div key={c.id} className="notice notice-warn" role="status"><div className="grow">{staleReason(c)}. Its nodes show the last good data.</div></div>)}
      <section className="panel" aria-label="Nodes">
        {!fleet ? <div className="muted panel-body" role="status">Loading nodes</div> : rows.length === 0 ? <Empty title="No nodes">Register a cluster on the Clusters page.</Empty> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th scope="col">Node</th><th scope="col">Cluster</th><th scope="col">Status</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col" className="right">Guests</th><th scope="col">Up for</th><th scope="col">Version</th></tr></thead>
            <tbody>{rows.map(({ c, n }) => (
              <tr key={`${c.id}/${n.name}`}>
                <td className="strong"><Link to={nodePath(c.id, n.name)}>{n.name}</Link></td>
                <td className="text-2">{c.name}</td>
                <td><Status tone={c.stale ? 'warn' : n.online ? 'ok' : 'crit'}>{c.stale ? 'unknown' : n.online ? 'online' : 'offline'}</Status></td>
                <td style={{ minWidth: 150 }}>{n.online ? <Meter used={n.cpu} total={1} label={`${n.name} CPU`} text={`${formatPct(n.cpu)} of ${n.maxcpu}`} fixed /> : ''}</td>
                <td style={{ minWidth: 200 }}>{n.online ? <Meter used={n.mem} total={n.maxmem} label={`${n.name} memory`} text={`${formatBytes(n.mem)} of ${formatBytes(n.maxmem)}`} fixed /> : ''}</td>
                <td className="num right">{n.guests}</td>
                <td className="text-2 nowrap">{n.online ? uptime(n.uptime) : ''}</td>
                <td className="text-2">{(n.pveversion ?? '').replace(/^pve-manager\//, '')}{n.kernel ? <div className="ws">kernel {n.kernel}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

export function StorageList() {
  useCrumbs([{ label: 'Storage' }]);
  const { fleet } = useApp();
  const [cluster, setCluster] = useState('');
  const rows = (fleet?.clusters ?? []).filter((c) => !cluster || c.id === cluster).flatMap((c) => uniqueStorage(c).map((s) => ({ c, s })));
  return (
    <div className="page">
      <div className="page-head"><h1>Storage</h1><ClusterFilter value={cluster} onChange={setCluster} /></div>
      <section className="panel" aria-label="Storage">
        {!fleet ? <div className="muted panel-body" role="status">Loading storage</div> : rows.length === 0 ? <Empty title="No storage reported" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th scope="col">Storage</th><th scope="col">Cluster</th><th scope="col">Type</th><th scope="col">Nodes</th><th scope="col">Used</th><th scope="col">Status</th></tr></thead>
            <tbody>{rows.map(({ c, s }) => (
              <tr key={`${c.id}/${storageKey(s.id, s.node, s.shared)}`}>
                <td className="strong"><Link to={storagePath(c.id, s.id, s.node, s.shared)}>{s.id}</Link></td>
                <td className="text-2">{c.name}</td>
                <td className="text-2">{s.type}{s.shared ? ', shared' : ''}</td>
                <td className="text-2">{s.nodes.join(', ')}</td>
                <td style={{ minWidth: 240 }}>{storageUnavailable(s) || s.disabled ? '' : <Meter used={s.used} total={s.total} label={`${s.id} ${pctLabel(s.used, s.total)} used`} text={`${formatBytes(s.used)} of ${formatBytes(s.total)}`} fixed />}</td>
                <td>{s.disabled ? <Badge>Disabled</Badge> : storageUnavailable(s) ? <Badge kind="crit">Unavailable</Badge> : <Badge kind="ok">Available</Badge>}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}

export function Activity() {
  useCrumbs([{ label: 'Activity' }]);
  const { tasks, runningChanges, clusterName } = useApp();
  const [cluster, setCluster] = useState('');
  const rows = tasks.filter((t) => !cluster || t.clusterId === cluster);
  return (
    <div className="page">
      <div className="page-head">
        <h1>Activity</h1>
        <ClusterFilter value={cluster} onChange={setCluster} />
        <div className="sub">The newest 50 PVE tasks across clusters, live. You see your own tasks, and everyone&apos;s where you hold Sys.Audit.</div>
      </div>
      {runningChanges.length > 0 && (
        <section className="panel" aria-labelledby="rc-h">
          <div className="panel-head"><h2 id="rc-h">Changes running</h2></div>
          <ul className="rows" style={{ padding: '4px 16px' }}>
            {runningChanges.map((a) => <li key={a.id}><Badge kind="info">Running</Badge><span className="grow">{a.title}<div className="meta">{clusterName(a.clusterId)}, {a.actorUser ?? a.user}, started {ago(a.at)}</div></span></li>)}
          </ul>
        </section>
      )}
      <section className="panel" aria-label="Tasks">
        {rows.length === 0 ? <Empty title="No tasks yet">Tasks appear here as soon as PVE starts one.</Empty> : (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th scope="col">Started</th><th scope="col">Cluster</th><th scope="col">Node</th><th scope="col">Task</th><th scope="col">Guest or ID</th><th scope="col">User</th><th scope="col">Result</th></tr></thead>
            <tbody>{rows.map((t) => (
              <tr key={t.upid}>
                <td className="nowrap">{clock(t.starttime)}</td>
                <td className="text-2">{clusterName(t.clusterId)}</td>
                <td><Link to={nodePath(t.clusterId, t.node)}>{t.node}</Link></td>
                <td className="mono">{t.type}</td>
                <td className="num">{t.id || ''}</td>
                <td className="text-2">{t.user}</td>
                <td>{taskBadge(t.status, t.endtime)}{t.status && t.status !== 'OK' && !/^WARNINGS/.test(t.status) ? <div className="ws" style={{ marginTop: 4 }}>{t.status}</div> : null}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
