import { useState } from 'react';
import type { Finding, Fleet as FleetT } from '../api/types';
import { useApp } from '../state/app';
import { Bar, Dot, Empty, Level } from '../components/ui';
import { ago, bytes, pctLabel, uptime } from '../lib/format';

function tiles(f: FleetT) {
  const quorate = f.clusters.filter((c) => c.quorate).length;
  const cephs = f.clusters.filter((c) => c.ceph);
  const cephBad = cephs.filter((c) => c.ceph!.health !== 'HEALTH_OK');
  const covered = f.clusters.reduce((a, c) => a + c.backups.covered, 0);
  const total = f.clusters.reduce((a, c) => a + c.backups.total, 0);
  const unprot = total - covered;
  const ceph0 = cephs[0]?.ceph;
  return [
    {
      label: 'Quorum', value: `${f.totals.nodesOnline} / ${f.totals.nodes} nodes`,
      sub: quorate === f.clusters.length ? `${f.clusters.length === 1 ? 'cluster' : `all ${f.clusters.length} clusters`} quorate` : `${f.clusters.length - quorate} not quorate`,
      tone: quorate === f.clusters.length && f.totals.nodesOnline === f.totals.nodes ? 'ok' : 'crit',
    },
    cephs.length === 0
      ? { label: 'Ceph', value: '—', sub: 'no Ceph clusters', tone: 'muted' }
      : {
          label: cephs.length === 1 ? `Ceph · ${cephs[0].name}` : `Ceph · ${cephs.length} clusters`,
          value: cephBad.length ? cephBad[0].ceph!.health : 'HEALTH_OK',
          sub: ceph0 ? `${ceph0.osdsUp}/${ceph0.osdsTotal} OSDs · ${pctLabel(ceph0.usedBytes, ceph0.totalBytes)} of ${bytes(ceph0.totalBytes)}` : '',
          tone: cephBad.length ? (cephBad[0].ceph!.health === 'HEALTH_WARN' ? 'warn' : 'crit') : 'ok',
        },
    { label: 'Backups', value: `${covered} / ${total}`, sub: unprot ? `${unprot} guest${unprot === 1 ? '' : 's'} unprotected` : 'every guest in a job', tone: unprot ? 'warn' : 'ok' },
    { label: 'Guests', value: `${f.totals.running} running`, sub: `${f.totals.guests} total on ${f.totals.nodes} nodes`, tone: 'muted' },
  ];
}

export function Fleet() {
  const { fleet, openPlan, planState } = useApp();
  const [selected, setSelected] = useState<string | null>(null);

  if (!fleet) return <div className="page"><h1>Fleet</h1><div className="muted">Loading cluster state…</div></div>;

  const pick = (f: Finding) => {
    setSelected(f.id);
    if (f.fix) void openPlan({ action: f.fix.action, clusterId: f.clusterId, params: f.fix.params });
  };
  const nodes = fleet.clusters.flatMap((c) => c.nodes.map((n) => ({ c, n })));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Fleet</h1>
          <div className="muted">{fleet.totals.clusters} cluster{fleet.totals.clusters === 1 ? '' : 's'} · {fleet.totals.nodes} nodes · {fleet.totals.guests} guests · updated {ago(fleet.updatedAt)}</div>
        </div>
      </div>

      <div className="tiles">
        {tiles(fleet).map((t) => (
          <div className="tile" key={t.label}>
            <div className="muted small">{t.label}</div>
            <div className="tile-value">{t.value}</div>
            <div className={`small tone-${t.tone}`}>{t.sub}</div>
          </div>
        ))}
      </div>

      <section className="panel" aria-label="Health and drift">
        <div className="panel-head">
          <strong>Health &amp; drift</strong>
          <span className="muted">{fleet.findings.length ? `${fleet.findings.length} finding${fleet.findings.length === 1 ? '' : 's'} · select one with a fix to plan it` : 'all checks pass'}</span>
        </div>
        {fleet.findings.length === 0 && <Empty title="Nothing needs you">Quorum, Ceph, storage, HA and backup coverage all check out.</Empty>}
        <ul className="findings">
          {fleet.findings.map((f) => {
            const isSel = selected === f.id && planState.plan;
            return (
              <li key={f.id}>
                <button type="button" className={`finding${isSel ? ' selected' : ''}`} onClick={() => pick(f)} aria-pressed={!!isSel}>
                  <Level level={f.level} />
                  <span className="mono muted finding-where">{f.where}</span>
                  <span className="finding-msg">{f.message}</span>
                  <span className="finding-fix">{f.fix ? f.fix.label : <span className="muted">no automatic fix</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="panel" aria-label="Nodes">
        <div className="table-box">
          <table className="table">
            <thead>
              <tr><th scope="col">Node</th><th scope="col">Cluster</th><th scope="col">CPU</th><th scope="col">Memory</th><th scope="col">Guests</th><th scope="col">Uptime</th><th scope="col">Kernel</th></tr>
            </thead>
            <tbody>
              {nodes.map(({ c, n }) => (
                <tr key={`${c.id}/${n.name}`}>
                  <td className="strong"><Dot tone={n.online ? 'ok' : 'crit'} label={n.online ? 'online' : 'offline'} /> {n.name}</td>
                  <td className="muted">{c.name}</td>
                  <td><span className="meter"><Bar used={n.cpu} total={1} label={`${n.name} CPU`} /><span className="mono small">{Math.round(n.cpu * 100)}%</span></span></td>
                  <td><span className="meter"><Bar used={n.mem} total={n.maxmem} color="var(--purple)" label={`${n.name} memory`} /><span className="mono small">{bytes(n.mem)} / {bytes(n.maxmem)}</span></span></td>
                  <td className="mono">{n.guests}</td>
                  <td className="mono small muted">{uptime(n.uptime)}</td>
                  <td className="mono small muted">{n.kernel ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
