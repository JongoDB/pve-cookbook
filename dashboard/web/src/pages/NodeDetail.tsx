import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/http';
import type { Timeframe } from '../api/types';
import { useApp, useCrumbs } from '../state/app';
import { usePve } from '../lib/hooks';
import { pctLabel, uptime } from '../lib/format';
import { formatBytes, formatPct } from '../lib/units';
import { consolePath, guestPath, storagePath } from '../lib/links';
import { MetricChart } from '../components/MetricChart';
import { ApiErrorView } from '../components/ClusterLogin';
import { Badge, Empty, Meter, Status } from '../components/ui';
import { TimeRange } from './Overview';
import { guestTone } from './GuestDetail';
import { storageUnavailable, uniqueStorage } from './overview/Widgets';

interface NodeStatus {
  cpu?: number; uptime?: number; loadavg?: (string | number)[]; kversion?: string; pveversion?: string;
  cpuinfo?: { model?: string; sockets?: number; cores?: number; cpus?: number; mhz?: string };
  memory?: { total: number; used: number }; swap?: { total: number; used: number }; rootfs?: { total: number; used: number; avail?: number };
  'boot-info'?: { mode?: string; secureboot?: number };
  'current-kernel'?: { release?: string };
}
interface Iface { iface: string; type: string; active?: number; method?: string; cidr?: string; address?: string; gateway?: string; bridge_ports?: string; comments?: string; 'bridge_vlan_aware'?: number }
interface Disk { devpath: string; model?: string; serial?: string; size: number; type?: string; health?: string; used?: string; wearout?: number | string }

export function NodeDetail() {
  const { cluster = '', node = '' } = useParams();
  const { fleet, guests, clusterName, me } = useApp();
  const [tf, setTf] = useState<Timeframe>('hour');
  useCrumbs([{ label: 'Nodes', to: '/nodes' }, { label: clusterName(cluster) }, { label: node }]);
  const summary = fleet?.clusters.find((c) => c.id === cluster);
  const n = summary?.nodes.find((x) => x.name === node);
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;
  const st = usePve<NodeStatus>(authed ? cluster : null, `nodes/${node}/status`);
  const net = usePve<Iface[]>(authed ? cluster : null, `nodes/${node}/network`);
  const disks = usePve<Disk[]>(authed ? cluster : null, `nodes/${node}/disks/list`);
  const res = useMemo(() => [{ cluster, kind: 'node' as const, id: node, label: node }], [cluster, node]);

  if (fleet && !n) {
    return <div className="page"><h1>{node}</h1><Empty title={`No node ${node} on ${clusterName(cluster)}`}>It may have left the cluster, or your PVE account cannot see it. <Link to="/nodes">All nodes</Link></Empty></div>;
  }
  const s = st.data;
  const onNode = (guests ?? []).filter((g) => g.clusterId === cluster && g.node === node && !g.template).sort((a, b) => a.vmid - b.vmid);
  const storages = summary ? uniqueStorage(summary).filter((x) => x.nodes.includes(node)) : [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>{node}</h1>
        <Link className="btn" to={consolePath(cluster, 'node', node)} aria-disabled={!authed} onClick={(e) => { if (!authed) e.preventDefault(); }}
          title={authed ? 'Root shell on this node (needs Sys.Console)' : 'Log in to this cluster first'}>Shell</Link>
        <div className="sub">
          {n ? <Status tone={n.online ? 'ok' : 'crit'}>{n.online ? 'online' : 'offline'}</Status> : null} node of {clusterName(cluster)}
          {n?.online ? `, up ${uptime(s?.uptime ?? n.uptime)}` : ''}
        </div>
      </div>
      {!authed && <ApiErrorView error={new ApiError(409, 'cluster_login_required', '')} clusterId={cluster} />}
      {st.error ? <ApiErrorView error={st.error} clusterId={cluster} onRetry={st.reload} what="node status" /> : null}

      <div className="facts">
        <div className="fact"><span className="k">CPU</span><span className="v num">{n ? `${formatPct(s?.cpu ?? n.cpu)} of ${n.maxcpu} threads` : 'unknown'}</span></div>
        <div className="fact"><span className="k">Load average</span><span className="v num">{s?.loadavg ? s.loadavg.map((x) => Number(x).toFixed(2)).join(', ') : 'unknown'}</span></div>
        <div className="fact"><span className="k">Memory</span><span className="v">{s?.memory ? <Meter used={s.memory.used} total={s.memory.total} label="Memory used" text={`${formatBytes(s.memory.used)} of ${formatBytes(s.memory.total)}`} /> : n ? `${formatBytes(n.mem)} of ${formatBytes(n.maxmem)}` : 'unknown'}</span></div>
        <div className="fact"><span className="k">Swap</span><span className="v">{s?.swap ? (s.swap.total ? `${formatBytes(s.swap.used)} of ${formatBytes(s.swap.total)}` : 'none') : 'unknown'}</span></div>
        <div className="fact"><span className="k">Root file system</span><span className="v">{s?.rootfs ? <Meter used={s.rootfs.used} total={s.rootfs.total} label="Root file system used" text={`${formatBytes(s.rootfs.used)} of ${formatBytes(s.rootfs.total)}`} /> : 'unknown'}</span></div>
        <div className="fact"><span className="k">CPU model</span><span className="v">{s?.cpuinfo?.model ? `${s.cpuinfo.model}${s.cpuinfo.sockets ? `, ${s.cpuinfo.sockets} socket${s.cpuinfo.sockets === 1 ? '' : 's'}` : ''}` : 'unknown'}</span></div>
        <div className="fact"><span className="k">Kernel</span><span className="v">{s?.['current-kernel']?.release ?? n?.kernel ?? 'unknown'}</span></div>
        <div className="fact"><span className="k">PVE version</span><span className="v">{(s?.pveversion ?? n?.pveversion ?? 'unknown').replace(/^pve-manager\//, '')}</span></div>
        <div className="fact"><span className="k">Boot</span><span className="v">{s?.['boot-info']?.mode ? `${s['boot-info'].mode === 'efi' ? 'UEFI' : 'Legacy BIOS'}${s['boot-info'].secureboot ? ', Secure Boot' : ''}` : 'unknown'}</span></div>
      </div>

      <div className="ov-bar"><h2 style={{ marginRight: 'auto' }}>History</h2><TimeRange value={tf} onChange={setTf} /></div>
      <div className="grid-2">
        <div className="panel panel-body"><MetricChart title="CPU" resources={res} metrics={['cpu']} timeframe={tf} /></div>
        <div className="panel panel-body"><MetricChart title="Memory used" resources={res} metrics={['memUsed']} timeframe={tf} /></div>
        <div className="panel panel-body"><MetricChart title="Network" resources={res} metrics={['netIn', 'netOut']} timeframe={tf} /></div>
        <div className="panel panel-body"><MetricChart title="Pressure (PSI some, avg10)" resources={res} metrics={['pressureCpu', 'pressureIo', 'pressureMem']} timeframe={tf} /></div>
      </div>

      <section className="panel" aria-labelledby="ng-h">
        <div className="panel-head"><h2 id="ng-h">Guests on {node}</h2><span className="muted">{onNode.length}</span></div>
        {onNode.length === 0 ? <Empty title={guests ? 'No guests on this node' : 'Loading guests'} /> : (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th scope="col">VMID</th><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Status</th><th scope="col">CPU</th><th scope="col">Memory</th></tr></thead>
            <tbody>{onNode.map((g) => (
              <tr key={g.vmid}>
                <td className="num">{g.vmid}</td>
                <td><Link to={guestPath(g.clusterId, g.vmid)}>{g.name}</Link></td>
                <td className="text-2">{g.type === 'qemu' ? 'VM' : 'Container'}</td>
                <td><Status tone={guestTone(g.status)}>{g.status}</Status></td>
                <td className="num">{g.status === 'running' ? formatPct(g.cpu) : ''}</td>
                <td className="num">{g.status === 'running' ? `${formatBytes(g.mem)} of ${formatBytes(g.maxmem)}` : formatBytes(g.maxmem)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>

      <div className="grid-2">
        <section className="panel" aria-labelledby="ns-h">
          <div className="panel-head"><h2 id="ns-h">Storage</h2></div>
          {storages.length === 0 ? <Empty title="No storage reported for this node" /> : (
            <ul className="rows" style={{ padding: '4px 16px' }}>
              {storages.map((x) => (
                <li key={x.id}>
                  <span style={{ flex: '1 1 120px' }}><Link to={storagePath(cluster, x.id, node, x.shared)}>{x.id}</Link><div className="meta">{x.type}{x.shared ? ', shared' : ''}</div></span>
                  <span style={{ flex: '2 1 160px' }}>
                    {x.disabled ? <Badge>Disabled</Badge> : storageUnavailable(x) ? <Badge kind="crit">Unavailable</Badge>
                      : <Meter used={x.used} total={x.total} label={`${x.id} ${pctLabel(x.used, x.total)} used`} text={`${formatBytes(x.used)} of ${formatBytes(x.total)}`} />}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="panel" aria-labelledby="nn-h">
          <div className="panel-head"><h2 id="nn-h">Network interfaces</h2></div>
          {net.error ? <div className="panel-body"><ApiErrorView error={net.error} clusterId={cluster} onRetry={net.reload} what="interfaces" /></div>
            : !net.data ? <div className="muted panel-body" role="status">{authed ? 'Loading interfaces' : 'Log in to see interfaces'}</div> : (
              <div className="table-wrap"><table className="table dense">
                <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Address</th><th scope="col">Ports or comment</th></tr></thead>
                <tbody>{net.data.slice().sort((a, b) => a.iface.localeCompare(b.iface)).map((i) => (
                  <tr key={i.iface}>
                    <td className="mono">{i.iface}</td>
                    <td className="text-2">{i.type}{i.active ? '' : ', inactive'}{i.bridge_vlan_aware ? ', VLAN aware' : ''}</td>
                    <td className="mono">{i.cidr ?? i.address ?? ''}{i.gateway ? <div className="ws">gateway {i.gateway}</div> : null}</td>
                    <td className="text-2">{[i.bridge_ports, i.comments].filter(Boolean).join(', ')}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
        </section>
      </div>

      <section className="panel" aria-labelledby="nd-h">
        <div className="panel-head"><h2 id="nd-h">Disks</h2></div>
        {disks.error ? (
          disks.error instanceof ApiError && disks.error.status === 403
            ? <Empty title="Disk list not available">Listing disks needs Sys.Audit on /nodes/{node}. Your PVE account does not have it.</Empty>
            : <div className="panel-body"><ApiErrorView error={disks.error} clusterId={cluster} onRetry={disks.reload} what="disks" /></div>
        ) : !disks.data ? <div className="muted panel-body" role="status">{authed ? 'Loading disks' : 'Log in to see disks'}</div> : (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th scope="col">Device</th><th scope="col">Model</th><th scope="col">Size</th><th scope="col">Type</th><th scope="col">Used by</th><th scope="col">Health</th><th scope="col">Wear left</th></tr></thead>
            <tbody>{disks.data.map((d) => (
              <tr key={d.devpath}>
                <td className="mono">{d.devpath}</td>
                <td>{d.model ?? 'unknown'}{d.serial ? <div className="ws mono">{d.serial}</div> : null}</td>
                <td className="num">{formatBytes(d.size)}</td>
                <td className="text-2">{d.type ?? ''}</td>
                <td className="text-2">{d.used ?? 'unused'}</td>
                <td>{d.health === 'PASSED' || d.health === 'OK' ? <Badge kind="ok">{d.health}</Badge> : d.health ? <Badge kind="crit">{d.health}</Badge> : <span className="muted">unknown</span>}</td>
                <td className="num">{typeof d.wearout === 'number' ? `${d.wearout}%` : 'n/a'}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </div>
  );
}
