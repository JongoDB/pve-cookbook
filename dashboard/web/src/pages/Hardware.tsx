import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../api/http';
import { useApp, useCrumbs } from '../state/app';
import { usePve } from '../lib/hooks';
import { guestPath } from '../lib/links';
import { useGpuUsage, usersOf } from '../lib/gpuUsage';
import { deviceName, groupPeers, isDisplay, isGpu, mapEntries, mapLine, mappingFor, suggestMappingId, type PciDevice, type PciMapping } from '../lib/pci';
import { ApiErrorView } from '../components/ClusterLogin';
import { ClusterPicker, useClusterParam } from '../components/ClusterPicker';
import { ResourceEditor } from '../components/ResourceEditor';
import { Badge, Empty } from '../components/ui';
import { HelpLink } from '../components/HelpLink';

/** PCI classes PVE hides by default: memory controllers, bridges, processors. */
const CHIPSET = /^0x(05|06|0b)/;

export function Hardware() {
  useCrumbs([{ label: 'Hardware' }]);
  const { me, fleet, lastAudit } = useApp();
  const [cluster, setCluster] = useClusterParam();
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;
  const nodes = fleet?.clusters.find((c) => c.id === cluster)?.nodes ?? [];
  const refresh = lastAudit?.status === 'running' ? '' : lastAudit?.id ?? '';
  const mappings = usePve<PciMapping[]>(authed ? cluster : null, 'cluster/mapping/pci', {}, refresh);
  const usage = useGpuUsage(authed ? [cluster] : [], refresh)?.[0];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Hardware</h1><HelpLink />
        <ClusterPicker value={cluster} onChange={setCluster} />
        <div className="sub">PCI devices of every node, GPUs first, with their IOMMU groups and cluster mappings. A mapping names a device cluster-wide so VMs, HA and migration can use it safely.</div>
      </div>
      {!authed ? <ApiErrorView error={new ApiError(409, 'cluster_login_required', '')} clusterId={cluster} /> : <>
        <section className="panel" aria-labelledby="map-h">
          <div className="panel-head"><h2 id="map-h">PCI mappings</h2>{mappings.data && <span className="muted">{mappings.data.length}</span>}</div>
          {mappings.error ? <div className="panel-body"><ApiErrorView error={mappings.error} clusterId={cluster} onRetry={mappings.reload} what="PCI mappings" /></div>
            : !mappings.data ? <div className="muted panel-body" role="status">Loading mappings</div>
              : !mappings.data.length ? <Empty title="No PCI mappings yet">Create one from a GPU below. VMs then refer to the mapping, not to a slot on one node.</Empty> : (
                <div className="table-wrap"><table className="table dense">
                  <thead><tr><th scope="col">Mapping</th><th scope="col">Devices</th><th scope="col">Used by</th></tr></thead>
                  <tbody>{mappings.data.map((m) => {
                    const users = usage ? usersOf(usage, m.id) : null;
                    return (
                      <tr key={m.id}>
                        <td><span className="mono">{m.id}</span>{m.description && <div className="ws">{m.description}</div>}</td>
                        <td>{mapEntries(m).map((e) => <div key={`${e.node}${e.path}`} className="mono small">{e.node} {e.path}{e.iommugroup ? `, IOMMU group ${e.iommugroup}` : ''}</div>)}</td>
                        <td>{users === null ? <span className="muted">Checking</span> : users.length
                          ? users.map((u) => <div key={`${u.guest.vmid}${u.key}`}><Link to={guestPath(u.guest.clusterId, u.guest.vmid)}>{u.guest.name}</Link> <span className="ws">{u.guest.vmid}, {u.key}</span></div>)
                          : <Badge kind="ok">Free</Badge>}</td>
                      </tr>
                    );
                  })}</tbody>
                </table></div>
              )}
          {usage?.users.some((u) => u.host) && (
            <div className="panel-body notice-inline">
              <span className="muted small">Raw devices (no mapping): {usage.users.filter((u) => u.host).map((u) => `${u.guest.name} uses ${u.host}`).join('; ')}. These VMs cannot move to another node.</span>
            </div>
          )}
        </section>
        {nodes.map((n) => <NodePci key={n.name} cluster={cluster} node={n.name} mappings={mappings.data ?? []} refresh={refresh} />)}
      </>}
    </div>
  );
}

function NodePci({ cluster, node, mappings, refresh }: { cluster: string; node: string; mappings: PciMapping[]; refresh: string }) {
  const pci = usePve<PciDevice[]>(cluster, `nodes/${node}/hardware/pci`, { 'pci-class-blacklist': '' }, refresh);
  const [creating, setCreating] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);
  const list = (pci.data ?? []).slice().sort((a, b) => Number(isGpu(b)) - Number(isGpu(a)) || Number(isDisplay(b)) - Number(isDisplay(a)) || a.id.localeCompare(b.id));
  const gpus = list.filter(isGpu);
  const chipset = list.filter((d) => CHIPSET.test(d.class));
  const rest = list.filter((d) => !isGpu(d) && !CHIPSET.test(d.class));
  const shown = showAll ? [...rest, ...chipset] : rest;

  const row = (d: PciDevice) => {
    const m = mappingFor(mappings, node, d.id);
    const peers = groupPeers(pci.data ?? [], d);
    const gpu = isGpu(d);
    return [
      <tr key={d.id} className={gpu ? 'gpu-row' : ''}>
        <td className="mono nowrap">{d.id}</td>
        <td>{deviceName(d)}{gpu && <> <Badge kind="info">GPU</Badge></>}<div className="ws mono">{d.class} {d.vendor?.replace(/^0x/, '')}:{d.device?.replace(/^0x/, '')}</div></td>
        <td className="num">{d.iommugroup >= 0 ? d.iommugroup : 'none'}{gpu && <div className="ws">{peers.length ? `shared with ${peers.map((p) => p.id).join(', ')}` : 'isolated'}</div>}</td>
        <td>{m ? <span className="mono">{m.id}</span> : gpu
          ? <button type="button" className="btn btn-sm" aria-expanded={creating === d.id} onClick={() => setCreating(creating === d.id ? null : d.id)}>Create mapping</button>
          : <span className="muted">none</span>}</td>
      </tr>,
      creating === d.id && (
        <tr key={`${d.id}-edit`}><td colSpan={4} className="editor-cell">
          <ResourceEditor clusterId={cluster} path="/cluster/mapping/pci" method="POST" heading={`Map ${deviceName(d)} at ${node} ${d.id}`}
            title={`Create PCI mapping for ${deviceName(d)} on ${node}`}
            initial={{ id: suggestMappingId(d, mappings), map: mapLine(node, d), description: `${deviceName(d)} at ${d.id} on ${node}` }}
            keys={['id', 'map', 'description']} onCancel={() => setCreating(null)} onSubmitted={() => setCreating(null)} />
          {peers.length > 0 && <p className="tone-warn small" style={{ marginTop: 8 }}>IOMMU group {d.iommugroup} also holds {peers.map((p) => p.id).join(', ')}. Passthrough hands the whole group to the VM.</p>}
        </td></tr>
      ),
    ];
  };

  return (
    <section className="panel" aria-labelledby={`pci-${node}`}>
      <div className="panel-head"><h2 id={`pci-${node}`}>{node}</h2>{pci.data && <span className="muted">{gpus.length ? `${gpus.length} GPU${gpus.length === 1 ? '' : 's'}, ` : ''}{list.length} PCI devices</span>}</div>
      {pci.error ? <div className="panel-body">{pci.error instanceof ApiError && pci.error.status === 403
        ? <Empty title="PCI devices not available">Listing them needs Sys.Audit or Sys.Modify on /. Your PVE account has neither on this cluster.</Empty>
        : <ApiErrorView error={pci.error} clusterId={cluster} onRetry={pci.reload} what={`PCI devices of ${node}`} />}</div>
        : !pci.data ? <div className="muted panel-body" role="status">Loading PCI devices</div> : (
          <div className="table-wrap"><table className="table dense">
            <thead><tr><th scope="col">Address</th><th scope="col">Device</th><th scope="col">IOMMU group</th><th scope="col">Mapping</th></tr></thead>
            <tbody>
              {gpus.map(row)}
              {shown.map(row)}
            </tbody>
          </table>
            {chipset.length > 0 && <div className="panel-body"><button type="button" className="link-btn small" onClick={() => setShowAll((v) => !v)}>{showAll ? 'Hide bridges and chipset devices' : `Show ${chipset.length} bridges and chipset devices`}</button></div>}
          </div>
        )}
    </section>
  );
}
