import { useState } from 'react';
import { useApp } from '../state/app';
import { Empty } from '../components/ui';
import { clock } from '../lib/format';

function taskTone(status?: string) {
  if (!status) return 'running';
  if (status === 'OK') return 'ok';
  if (/^WARNINGS/.test(status)) return 'warn';
  return 'crit';
}

export function Operations() {
  const { tasks, me, clusterName } = useApp();
  const [cluster, setCluster] = useState('');
  const rows = tasks.filter((t) => !cluster || t.clusterId === cluster);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Operations</h1>
          <div className="muted">Recent PVE tasks across clusters, live. Every action galley runs appears here under your own user.</div>
        </div>
        <label className="field inline"><span>Cluster</span>
          <select value={cluster} onChange={(e) => setCluster(e.target.value)}>
            <option value="">All</option>
            {me.clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
      </div>
      <section className="panel" aria-label="Tasks">
        {rows.length === 0 ? <Empty title="No tasks yet" /> : (
          <div className="table-box">
            <table className="table dense">
              <thead><tr><th scope="col">Started</th><th scope="col">Cluster</th><th scope="col">Node</th><th scope="col">Type</th><th scope="col">ID</th><th scope="col">User</th><th scope="col">Status</th></tr></thead>
              <tbody>
                {rows.map((t) => {
                  const tone = taskTone(t.status);
                  return (
                    <tr key={t.upid}>
                      <td className="mono small">{clock(t.starttime)}</td>
                      <td className="muted">{clusterName(t.clusterId)}</td>
                      <td className="mono">{t.node}</td>
                      <td className="mono">{t.type}</td>
                      <td className="mono">{t.id || '—'}</td>
                      <td className="muted">{t.user}</td>
                      <td className={`tone-${tone === 'running' ? 'info' : tone}`}>{t.status ?? 'running…'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
