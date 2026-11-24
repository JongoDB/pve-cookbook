import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiError } from '../api/http';
import type { Timeframe } from '../api/types';
import { useApp, useCrumbs } from '../state/app';
import { usePve } from '../lib/hooks';
import { clock, pctLabel } from '../lib/format';
import { formatBytes } from '../lib/units';
import { guestPath, nodePath } from '../lib/links';
import { MetricChart } from '../components/MetricChart';
import { ApiErrorView } from '../components/ClusterLogin';
import { Badge, Empty, Meter } from '../components/ui';
import { TimeRange } from './Overview';
import { storageUnavailable } from './overview/Widgets';
import { HelpLink } from '../components/HelpLink';

interface Volume { volid: string; content: string; format?: string; size?: number; used?: number; vmid?: number; ctime?: number; notes?: string }

const CONTENT_LABEL: Record<string, string> = {
  images: 'VM disks', rootdir: 'Container volumes', iso: 'ISO images', vztmpl: 'Container templates',
  backup: 'Backups', snippets: 'Snippets', import: 'Import',
};

export function StorageDetail() {
  const { cluster = '', storage = '' } = useParams();
  const [sid, onlyNode] = storage.split('@');
  const { fleet, guests, clusterName, me } = useApp();
  const [tf, setTf] = useState<Timeframe>('week');
  useCrumbs([{ label: 'Storage', to: '/storage' }, { label: clusterName(cluster) }, { label: onlyNode ? `${sid} on ${onlyNode}` : sid }]);
  const summary = fleet?.clusters.find((c) => c.id === cluster);
  const entries = (summary?.storage ?? []).filter((s) => s.id === sid && (!onlyNode || s.node === onlyNode));
  const first = entries.find((s) => s.active) ?? entries[0];
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;
  const content = usePve<Volume[]>(authed && first && !storageUnavailable(first) ? cluster : null, first ? `nodes/${first.node}/storage/${sid}/content` : null);
  const res = useMemo(() => [{ cluster, kind: 'storage' as const, id: storage, label: sid }], [cluster, storage, sid]);

  const groups = useMemo(() => {
    const m = new Map<string, Volume[]>();
    for (const v of content.data ?? []) m.set(v.content, [...(m.get(v.content) ?? []), v]);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [content.data]);

  if (fleet && !first) {
    return <div className="page"><h1>{sid}</h1><Empty title={`No storage ${sid}${onlyNode ? ` on ${onlyNode}` : ''} in ${clusterName(cluster)}`}>It may have been removed from the storage configuration. <Link to="/storage">All storage</Link></Empty></div>;
  }
  if (!first) return <div className="page"><h1>{sid}</h1><div className="muted" role="status">Loading storage</div></div>;

  const down = storageUnavailable(first);
  const name = (vmid?: number) => (vmid ? guests?.find((g) => g.clusterId === cluster && g.vmid === vmid)?.name : undefined);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{sid}{onlyNode ? <span className="title-id"> on {onlyNode}</span> : null}</h1><HelpLink />
        <div className="sub">{first.type} storage, {first.shared ? 'shared by every node that lists it' : `local to ${first.node}`}, {clusterName(cluster)}</div>
      </div>

      <div className="facts">
        <div className="fact"><span className="k">Used</span>
          <span className="v">{first.disabled ? <Badge>Disabled</Badge> : down ? <><Badge kind="crit">Unavailable</Badge> <span className="ws">PVE reports {first.status ?? 'inactive'}</span></>
            : <Meter used={first.used} total={first.total} label={`${pctLabel(first.used, first.total)} used`} text={`${formatBytes(first.used)} of ${formatBytes(first.total)}`} />}</span>
        </div>
        <div className="fact"><span className="k">Free</span><span className="v num">{down ? 'unknown' : formatBytes(Math.max(0, first.total - first.used))}</span></div>
        <div className="fact"><span className="k">Type</span><span className="v">{first.type}</span></div>
        <div className="fact"><span className="k">Seen by</span><span className="v">{entries.map((e, i) => <span key={e.node}>{i ? ', ' : ''}<Link to={nodePath(cluster, e.node)}>{e.node}</Link>{storageUnavailable(e) ? ' (unavailable)' : ''}</span>)}</span></div>
      </div>

      <section className="panel panel-body" aria-label="Usage history">
        <div className="ov-bar" style={{ marginBottom: 6 }}><h2 style={{ marginRight: 'auto' }}>Used space</h2><TimeRange value={tf} onChange={setTf} /></div>
        <MetricChart title={`Used space on ${sid}`} resources={res} metrics={['diskUsed']} timeframe={tf} headless height={180} />
      </section>

      <section className="panel" aria-labelledby="sc-h">
        <div className="panel-head"><h2 id="sc-h">Content</h2>{content.data && <span className="muted">{content.data.length} volume{content.data.length === 1 ? '' : 's'}{first.shared ? `, as listed by ${first.node}` : ''}</span>}</div>
        {down ? <Empty title="Content not available">{sid} is not available, so PVE cannot list it. Check the storage backend (for NFS or CIFS: is the server reachable from {first.node}?).</Empty>
          : !authed ? <div className="panel-body"><ApiErrorView error={new ApiError(409, 'cluster_login_required', '')} clusterId={cluster} /></div>
            : content.error ? <div className="panel-body"><ApiErrorView error={content.error} clusterId={cluster} onRetry={content.reload} what="storage content" /></div>
              : !content.data ? <div className="muted panel-body" role="status">Loading content</div>
                : groups.length === 0 ? <Empty title="Empty">Nothing is stored here yet.</Empty> : groups.map(([type, vols]) => (
                  <div key={type}>
                    <h3 style={{ padding: '12px 16px 4px', fontFamily: 'var(--sans)', fontSize: 14 }}>{CONTENT_LABEL[type] ?? type} <span className="muted" style={{ fontWeight: 400 }}>{vols.length}, {formatBytes(vols.reduce((a, v) => a + (v.size ?? 0), 0))}</span></h3>
                    <div className="table-wrap"><table className="table dense">
                      <thead><tr><th scope="col">Volume</th><th scope="col">Guest</th><th scope="col" className="right">Size</th><th scope="col">Format</th><th scope="col">Created</th></tr></thead>
                      <tbody>{vols.map((v) => (
                        <tr key={v.volid}>
                          <td className="mono" style={{ wordBreak: 'break-all' }}>{v.volid.slice(v.volid.indexOf(':') + 1)}</td>
                          <td>{v.vmid ? <Link to={guestPath(cluster, v.vmid)}>{name(v.vmid) ?? v.vmid}</Link> : ''}</td>
                          <td className="num right">{v.size !== undefined ? formatBytes(v.size) : ''}</td>
                          <td className="text-2">{v.format ?? ''}</td>
                          <td className="nowrap text-2">{v.ctime ? clock(v.ctime) : ''}</td>
                        </tr>
                      ))}</tbody>
                    </table></div>
                  </div>
                ))}
      </section>
    </div>
  );
}
