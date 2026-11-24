import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import type { ClusterSummary } from '../api/types';
import { useApp, useCrumbs } from '../state/app';
import { usePve } from '../lib/hooks';
import { guestPath } from '../lib/links';
import { ApiErrorView } from '../components/ClusterLogin';
import { Badge, Empty, Meter } from '../components/ui';
import { staleReason } from './overview/Widgets';
import { HelpLink } from '../components/HelpLink';

interface BackupJob { id: string; schedule?: string; starttime?: string; dow?: string; storage?: string; mode?: string; all?: number; vmid?: string; exclude?: string; pool?: string; enabled?: number; comment?: string }

function selection(j: BackupJob): string {
  if (j.pool) return `pool ${j.pool}`;
  if (j.all) return j.exclude ? `all guests except ${j.exclude.split(',').join(', ')}` : 'all guests';
  return j.vmid ? `guests ${j.vmid.split(',').join(', ')}` : 'no guests';
}

function Jobs({ c }: { c: ClusterSummary }) {
  const { me, lastAudit } = useApp();
  const authed = !!me.clusters.find((x) => x.id === c.id)?.authed;
  const { data, error, reload } = usePve<BackupJob[]>(authed ? c.id : null, 'cluster/backup', {}, lastAudit?.status === 'running' ? '' : lastAudit?.id ?? '');
  if (!authed) return <div className="panel-body muted">Log in to {c.name} to see its backup jobs.</div>;
  if (error) return <div className="panel-body"><ApiErrorView error={error} clusterId={c.id} onRetry={reload} what="backup jobs" /></div>;
  if (!data) return <div className="panel-body muted" role="status">Loading backup jobs</div>;
  if (!data.length) return <Empty title="No backup jobs">Nothing on {c.name} is backed up on a schedule. Create a job in Datacenter, Backup in the PVE interface.</Empty>;
  return (
    <div className="table-wrap"><table className="table dense">
      <thead><tr><th scope="col">Job</th><th scope="col">Schedule</th><th scope="col">Storage</th><th scope="col">Mode</th><th scope="col">Backs up</th><th scope="col">State</th></tr></thead>
      <tbody>{data.map((j) => (
        <tr key={j.id}>
          <td className="mono">{j.id}</td>
          <td className="num">{j.schedule ?? [j.dow, j.starttime].filter(Boolean).join(' ')}</td>
          <td>{j.storage ?? ''}</td>
          <td className="text-2">{j.mode ?? 'snapshot'}</td>
          <td className="text-2">{selection(j)}</td>
          <td>{j.enabled === 0 ? <Badge kind="warn">Disabled</Badge> : <Badge kind="ok">Enabled</Badge>}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

export function Protection() {
  useCrumbs([{ label: 'Protection' }]);
  const { fleet, guests, openPlan } = useApp();
  const unprotected = useMemo(() => (fleet?.clusters ?? []).flatMap((c) => (c.backups.known === false ? [] : c.backups.unprotected.map((v) => ({ c, v })))), [fleet]);
  if (!fleet) return <div className="page"><h1>Protection</h1><div className="muted" role="status">Loading backup coverage</div></div>;
  const name = (cid: string, v: number) => guests?.find((g) => g.clusterId === cid && g.vmid === v);
  const fix = (cid: string, v: number) => fleet.findings.find((f) => f.check === 'backup-coverage' && f.clusterId === cid && f.resource?.id === String(v) && f.fix);

  return (
    <div className="page">
      <div className="page-head"><h1>Protection</h1><HelpLink /></div>
      <div className="grid-3">
        {fleet.clusters.map((c) => {
          const why = c.backups.known === false ? `Could not read backup coverage${c.errors?.['backup-coverage'] ? `: ${c.errors['backup-coverage']}` : ''}` : staleReason(c);
          return (
            <section key={c.id} className="w" style={{ gridColumn: 'auto' }} aria-labelledby={`pc-${c.id}`}>
              <div className="w-head"><h2 className="w-title" id={`pc-${c.id}`}>{c.name}</h2>{why ? <Badge kind="warn">Unknown</Badge> : c.backups.unprotected.length ? <Badge kind="warn">{c.backups.unprotected.length} unprotected</Badge> : <Badge kind="ok">All covered</Badge>}</div>
              {why ? <div className="ws">{why}. galley never counts unknown coverage as covered.</div> : (
                <>
                  <div className="big">{c.backups.covered} <span className="of">of {c.backups.total} guests in a backup job</span></div>
                  <Meter used={c.backups.covered} total={c.backups.total} label={`${c.name} backup coverage`} warnAt={101} critAt={101} />
                </>
              )}
            </section>
          );
        })}
      </div>

      <section className="panel" aria-labelledby="up-h">
        <div className="panel-head"><h2 id="up-h">Guests without a backup</h2><span className="muted">{unprotected.length}</span></div>
        {unprotected.length === 0 ? <Empty title="Every guest whose coverage galley can read is in a backup job" /> : (
          <div className="table-wrap"><table className="table">
            <thead><tr><th scope="col">Guest</th><th scope="col">Cluster</th><th scope="col">Node</th><th scope="col"><span className="sr-only">Fix</span></th></tr></thead>
            <tbody>{unprotected.map(({ c, v }) => {
              const g = name(c.id, v);
              const f = fix(c.id, v);
              return (
                <tr key={`${c.id}/${v}`}>
                  <td><Link to={guestPath(c.id, v)}>{g?.name ?? `Guest ${v}`}</Link> <span className="muted">{v}</span></td>
                  <td className="text-2">{c.name}</td>
                  <td className="text-2">{g?.node ?? ''}</td>
                  <td className="right">{f ? <button type="button" className="btn btn-sm" onClick={() => void openPlan({ action: f.fix!.action, clusterId: c.id, params: f.fix!.params })}>{f.fix!.label}</button> : <span className="muted">No automatic fix</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </section>

      {fleet.clusters.map((c) => (
        <section key={c.id} className="panel" aria-labelledby={`bj-${c.id}`}>
          <div className="panel-head"><h2 id={`bj-${c.id}`}>Backup jobs on {c.name}</h2></div>
          <Jobs c={c} />
        </section>
      ))}
    </div>
  );
}
