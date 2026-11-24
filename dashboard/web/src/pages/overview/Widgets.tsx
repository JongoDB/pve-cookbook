import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEntry, ClusterSummary, Finding, Fleet, Guest, Storage, Timeframe } from '../../api/types';
import { useApp } from '../../state/app';
import { useAsync } from '../../lib/hooks';
import { ago, bytes, pctLabel } from '../../lib/format';
import { formatPct } from '../../lib/units';
import { METRIC_PRESETS, type MetricConfig } from '../../lib/layout';
import { guestPath, storageKey, storagePath } from '../../lib/links';
import { MetricChart, type MetricResource } from '../../components/MetricChart';
import { Badge, Level, Meter } from '../../components/ui';
import { ApiErrorView } from '../../components/ClusterLogin';

export interface WidgetHead { title: string; sub?: React.ReactNode }

/** Why a cluster's data is not current, in the admin's words. */
export function staleReason(c: ClusterSummary, section?: string): string | null {
  if (c.stale) return `${c.name} has not answered recently${c.lastSuccess ? `; last good data ${ago(c.lastSuccess)}` : ''}${c.errors?.status ? ` (${c.errors.status})` : c.errors?.resources ? ` (${c.errors.resources})` : ''}`;
  if (section && c.errors?.[section]) return `${c.name}: ${c.errors[section]}`;
  return null;
}

const Unknown = ({ children }: { children: React.ReactNode }) => <div className="ws"><Badge kind="warn">Unknown</Badge> {children}</div>;

// ---------- Quorum ----------
export function QuorumWidget({ fleet }: { fleet: Fleet }) {
  const cs = fleet.clusters;
  const stale = cs.filter((c) => c.stale);
  const notQuorate = cs.filter((c) => !c.stale && !c.quorate);
  return (
    <>
      <div className="big">{fleet.totals.nodesOnline} <span className="of">of {fleet.totals.nodes} nodes online</span></div>
      {notQuorate.map((c) => <div key={c.id} className="ws"><Badge kind="crit">Not quorate</Badge> {c.name}</div>)}
      {stale.map((c) => <Unknown key={c.id}>{staleReason(c)}</Unknown>)}
      {!notQuorate.length && !stale.length && (
        <div className="ws">{cs.length === 1 ? `${cs[0].name} is quorate` : `All ${cs.length} clusters quorate`}</div>
      )}
    </>
  );
}

// ---------- Ceph ----------
const cephKind = (h: string) => (h === 'HEALTH_OK' ? 'ok' : h === 'HEALTH_WARN' ? 'warn' : 'crit');

export function CephWidget({ fleet }: { fleet: Fleet }) {
  const cs = fleet.clusters.filter((c) => c.ceph);
  if (!cs.length) return <div className="ws">No registered cluster runs Ceph.</div>;
  if (cs.length === 1) {
    const c = cs[0];
    const ceph = c.ceph!;
    const why = staleReason(c, 'ceph');
    return (
      <>
        <div className="big">{bytes(ceph.usedBytes)} <span className="of">of {bytes(ceph.totalBytes)}</span></div>
        <Meter used={ceph.usedBytes} total={ceph.totalBytes} label={`Ceph on ${c.name}: ${pctLabel(ceph.usedBytes, ceph.totalBytes)} used`} />
        <div className="ws" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Badge kind={cephKind(ceph.health)}>{ceph.health}</Badge>{ceph.osdsUp} of {ceph.osdsTotal} OSDs up, {ceph.osdsIn} in</div>
        {why && <Unknown>{why}. Showing the last good reading.</Unknown>}
      </>
    );
  }
  return (
    <ul className="rows">
      {cs.map((c) => (
        <li key={c.id}>
          <span className="grow">{c.name}<div className="meta">{c.ceph!.osdsUp} of {c.ceph!.osdsTotal} OSDs up, {pctLabel(c.ceph!.usedBytes, c.ceph!.totalBytes)} used</div></span>
          {staleReason(c, 'ceph') ? <Badge kind="warn">Unknown</Badge> : <Badge kind={cephKind(c.ceph!.health)}>{c.ceph!.health}</Badge>}
        </li>
      ))}
    </ul>
  );
}
export const cephTitle = (fleet: Fleet | null): WidgetHead => {
  const cs = fleet?.clusters.filter((c) => c.ceph) ?? [];
  if (cs.length !== 1) return { title: 'Ceph' };
  return { title: 'Ceph', sub: cs[0].name };
};

// ---------- Backups ----------
export function BackupsWidget({ fleet, guests }: { fleet: Fleet; guests: Guest[] | null }) {
  const { openPlan } = useApp();
  const known = fleet.clusters.filter((c) => c.backups.known !== false && !c.stale);
  const unknown = fleet.clusters.filter((c) => c.backups.known === false || c.stale);
  const covered = known.reduce((a, c) => a + c.backups.covered, 0);
  const total = known.reduce((a, c) => a + c.backups.total, 0);
  const name = (cid: string, vmid: number) => guests?.find((g) => g.clusterId === cid && g.vmid === vmid)?.name;
  const unprot = known.flatMap((c) => c.backups.unprotected.map((v) => ({ c, v })));
  const fixFor = (cid: string, vmid: number) => fleet.findings.find((f) => f.check === 'backup-coverage' && f.clusterId === cid && f.resource?.id === String(vmid) && f.fix);
  return (
    <>
      {known.length > 0
        ? <div className="big">{covered} <span className="of">of {total} guests</span></div>
        : <div className="big">Unknown</div>}
      {unprot.slice(0, 3).map(({ c, v }) => {
        const f = fixFor(c.id, v);
        return (
          <div key={`${c.id}/${v}`} className="ws" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span className="tone-warn" style={{ flex: 1 }}>{name(c.id, v) ? `${name(c.id, v)} (${v})` : `Guest ${v}`} has no backup</span>
            {f && <button type="button" className="link-btn" onClick={() => void openPlan({ action: f.fix!.action, clusterId: f.clusterId, params: f.fix!.params })}>Review fix</button>}
          </div>
        );
      })}
      {unprot.length > 3 && <div className="ws"><Link to="/protection">{unprot.length - 3} more without a backup</Link></div>}
      {known.length > 0 && unprot.length === 0 && <div className="ws">Every guest is in a backup job</div>}
      {unknown.map((c) => <Unknown key={c.id}>{c.name}: {c.stale ? staleReason(c) : `could not read backup coverage${c.errors?.['backup-coverage'] ? ` (${c.errors['backup-coverage']})` : ''}`}</Unknown>)}
    </>
  );
}

// ---------- Guests ----------
export function GuestsWidget({ fleet }: { fleet: Fleet }) {
  const stale = fleet.clusters.filter((c) => c.stale);
  return (
    <>
      <div className="big">{fleet.totals.running} <span className="of">of {fleet.totals.guests} running</span></div>
      <div className="ws">on {fleet.totals.nodesOnline} online node{fleet.totals.nodesOnline === 1 ? '' : 's'}, <Link to="/guests">all guests</Link></div>
      {stale.map((c) => <Unknown key={c.id}>{staleReason(c)}</Unknown>)}
    </>
  );
}

// ---------- Needs attention ----------
const LEVEL_ORDER = { CRIT: 0, WARN: 1, INFO: 2 } as const;

export function AttentionWidget({ fleet }: { fleet: Fleet }) {
  const { openPlan } = useApp();
  const [all, setAll] = useState(false);
  const findings = useMemo(() => fleet.findings.slice().sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]), [fleet.findings]);
  if (!findings.length) return <div className="ws">No findings. Quorum, Ceph, storage, HA and backup coverage all check out.</div>;
  const shown = all ? findings : findings.slice(0, 4);
  const open = (f: Finding) => f.fix && void openPlan({ action: f.fix.action, clusterId: f.clusterId, params: f.fix.params });
  return (
    <>
      <ul className="rows">
        {shown.map((f) => (
          <li key={f.id}>
            <Level level={f.level} />
            <span className="grow" title={f.where}>{f.message}<div className="meta">{f.where}</div></span>
            {f.fix && (
              <button type="button" className="link-btn nowrap" onClick={() => open(f)} aria-label={`${f.fix.label}: open as a change`}>
                {f.fix.label}
              </button>
            )}
          </li>
        ))}
      </ul>
      {findings.length > 4 && <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${findings.length}`}</button>}
    </>
  );
}

// ---------- Storage capacity ----------
export function uniqueStorage(c: ClusterSummary): (Storage & { nodes: string[] })[] {
  const out = new Map<string, Storage & { nodes: string[] }>();
  for (const s of c.storage) {
    const k = storageKey(s.id, s.node, s.shared);
    const prev = out.get(k);
    if (prev) prev.nodes.push(s.node);
    else out.set(k, { ...s, nodes: [s.node] });
  }
  return [...out.values()];
}

export const storageUnavailable = (s: Storage) => !s.disabled && (!s.active || (s.status !== undefined && s.status !== 'available'));

export function StorageWidget({ fleet }: { fleet: Fleet }) {
  const rows = fleet.clusters.flatMap((c) => uniqueStorage(c).filter((s) => !s.disabled).map((s) => ({ c, s })))
    .sort((a, b) => Number(storageUnavailable(b.s)) - Number(storageUnavailable(a.s)) || (b.s.total ? b.s.used / b.s.total : 0) - (a.s.total ? a.s.used / a.s.total : 0));
  if (!rows.length) return <div className="ws">No storage reported yet.</div>;
  const multi = fleet.clusters.length > 1;
  return (
    <ul className="rows">
      {rows.slice(0, 8).map(({ c, s }) => (
        <li key={`${c.id}/${storageKey(s.id, s.node, s.shared)}`} style={{ flexWrap: 'wrap' }}>
          <span style={{ flex: '1 1 150px', minWidth: 0 }}>
            <Link to={storagePath(c.id, s.id, s.node, s.shared)}>{s.id}</Link>
            <div className="meta">{s.shared ? 'shared' : s.node}{multi ? `, ${c.name}` : ''}</div>
          </span>
          <span style={{ flex: '2 1 200px', minWidth: 0 }}>
            {storageUnavailable(s)
              ? <><Badge kind="crit">Unavailable</Badge> <span className="ws">PVE reports {s.status ?? 'inactive'}</span></>
              : <Meter used={s.used} total={s.total} label={`${s.id} ${pctLabel(s.used, s.total)} used`} text={`${bytes(s.used)} of ${bytes(s.total)}`} />}
          </span>
        </li>
      ))}
      {rows.length > 8 && <li><Link to="/storage">All {rows.length} storages</Link></li>}
    </ul>
  );
}

// ---------- Top guests ----------
export function TopGuestsWidget({ guests, error }: { guests: Guest[] | null; error: string | null }) {
  const { clusterName, fleet } = useApp();
  if (!guests) return error ? <div className="ws">Could not load guests: {error}</div> : <div className="ws" role="status">Loading guests</div>;
  const top = guests.filter((g) => g.status === 'running' && !g.template).sort((a, b) => b.cpu - a.cpu).slice(0, 5);
  if (!top.length) return <div className="ws">No guest is running.</div>;
  const multi = (fleet?.clusters.length ?? 0) > 1;
  return (
    <ul className="rows">
      {top.map((g) => (
        <li key={`${g.clusterId}/${g.vmid}`}>
          <span className="grow"><Link to={guestPath(g.clusterId, g.vmid)}>{g.name}</Link> <span className="ws">{g.vmid}, {multi ? `${clusterName(g.clusterId)}/` : ''}{g.node}</span></span>
          <span style={{ flex: '0 0 130px' }}><Meter used={g.cpu} total={1} label={`${g.name} CPU`} text={formatPct(g.cpu)} /></span>
        </li>
      ))}
    </ul>
  );
}

// ---------- Recent changes ----------
export function auditBadge(a: AuditEntry) {
  if (a.status === 'running') return <Badge kind="info">Running</Badge>;
  return a.ok ? <Badge kind="ok">Done</Badge> : <Badge kind="crit">Failed</Badge>;
}

export function ChangesWidget() {
  const { api, lastAudit, clusterName } = useApp();
  const { data, error, reload } = useAsync(() => api.audit(6), `audit|${lastAudit?.id}|${lastAudit?.status}`);
  if (error) return <ApiErrorView error={error} what="the audit log" onRetry={reload} />;
  if (!data) return <div className="ws" role="status">Loading the audit log</div>;
  if (!data.length) return <div className="ws">No changes yet. Applied changes, logins and cluster edits appear here.</div>;
  return (
    <ul className="rows">
      {data.map((a) => (
        <li key={a.id}>
          {auditBadge(a)}
          <span className="grow">{a.title}<div className="meta">{clusterName(a.clusterId)}, {a.actorUser ?? a.user}, {ago(a.at)}</div></span>
        </li>
      ))}
      <li><Link to="/audit">Open the audit log</Link></li>
    </ul>
  );
}

// ---------- Running tasks ----------
export function TasksWidget() {
  const { tasks, clusterName } = useApp();
  const running = tasks.filter((t) => !t.endtime);
  const last = tasks.find((t) => t.endtime);
  return (
    <ul className="rows">
      {running.length === 0 && <li className="ws">No tasks running.{last ? ` Last finished: ${last.type}${last.id ? ` ${last.id}` : ''} on ${last.node}, ${ago(last.endtime!)}.` : ''}</li>}
      {running.slice(0, 6).map((t) => (
        <li key={t.upid}>
          <Badge kind="info">Running</Badge>
          <span className="grow">{t.type}{t.id ? ` ${t.id}` : ''}<div className="meta">{clusterName(t.clusterId)}/{t.node}, {t.user}, started {ago(t.starttime)}</div></span>
        </li>
      ))}
      <li><Link to="/activity">All activity</Link></li>
    </ul>
  );
}

// ---------- Metric chart ----------
export interface ResolvedMetric { title: string; sub?: string; resources: MetricResource[]; problem?: string }

export function resolveMetric(cfg: MetricConfig, ctx: { fleet: Fleet | null; guests: Guest[] | null; authed: (id: string) => boolean; clusterName: (id: string) => string }): ResolvedMetric {
  const preset = METRIC_PRESETS[cfg.metric];
  const clusters = ctx.fleet?.clusters ?? [];
  const cid = cfg.cluster || clusters.find((c) => ctx.authed(c.id))?.id || '';
  const summary = clusters.find((c) => c.id === cid);
  const cname = cid ? ctx.clusterName(cid) : '';
  const lower = /^[A-Z]{2,}/.test(preset.label) ? preset.label : preset.label.charAt(0).toLowerCase() + preset.label.slice(1);
  const autoTitle = cfg.kind === 'storage' && cfg.metric === 'storage' ? 'Storage used'
    : `${cfg.kind === 'cluster' ? 'Cluster' : cfg.kind === 'node' ? 'Node' : cfg.kind === 'guest' ? 'Guest' : 'Storage'} ${lower}`;
  const title = cfg.title || autoTitle;
  if (!cid) return { title, resources: [], problem: 'Log in to a cluster to see its history.' };
  if (!ctx.authed(cid)) return { title, sub: cname, resources: [], problem: `Log in to ${cname} to see its history.` };
  let ids = cfg.ids.filter((x) => cfg.kind !== 'cluster' || x === '');
  if (cfg.kind === 'cluster') ids = [''];
  if (cfg.kind === 'node' && !ids.length) ids = (summary?.nodes ?? []).filter((n) => n.online).map((n) => n.name);
  if (cfg.kind === 'storage' && !ids.length) {
    const s = summary?.storage.find((x) => x.shared && x.active) ?? summary?.storage.find((x) => x.active);
    if (s) ids = [storageKey(s.id, s.node, s.shared)];
  }
  if (!ids.length) return { title, sub: cname, resources: [], problem: 'Nothing selected. Choose resources in Edit layout.' };
  const label = (id: string) => {
    if (cfg.kind === 'cluster') return cname;
    if (cfg.kind === 'guest') return ctx.guests?.find((g) => g.clusterId === cid && String(g.vmid) === id)?.name ?? `Guest ${id}`;
    if (cfg.kind === 'storage') return id.replace('@', ' on ');
    return id;
  };
  return { title, sub: cname, resources: ids.map((id) => ({ cluster: cid, kind: cfg.kind, id, label: label(id) })) };
}

export function MetricWidget({ resolved, cfg, timeframe }: { resolved: ResolvedMetric; cfg: MetricConfig; timeframe: Timeframe }) {
  const metrics = METRIC_PRESETS[cfg.metric].series;
  if (resolved.problem) return <div className="ws" style={{ minHeight: 140 }}>{resolved.problem}</div>;
  return <MetricChart title={`${resolved.title}${resolved.sub ? `, ${resolved.sub}` : ''}`} resources={resolved.resources} metrics={metrics} timeframe={timeframe} headless height={200} />;
}

