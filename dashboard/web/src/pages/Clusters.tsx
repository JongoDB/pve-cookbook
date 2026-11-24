import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Cluster } from '../api/types';
import { errMsg, useApp } from '../state/app';
import { AddClusterForm } from './AddClusterForm';
import { Dot, ErrorBox } from '../components/ui';
import { ago } from '../lib/format';

function ClusterLogin({ id, name }: { id: string; name: string }) {
  const { api, setMe, me } = useApp();
  const [username, setUsername] = useState(me.user.split('@')[0] ?? 'root');
  const [realm, setRealm] = useState(me.user.split('@')[1] ?? 'pam');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <form className="inline-form wrap" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr(null);
      try { setMe(await api.clusterLogin(id, { username, realm, password, ...(otp ? { otp } : {}) })); }
      catch (e2) { setErr(errMsg(e2)); setPassword(''); } finally { setBusy(false); }
    }}>
      <span className="muted small">You can see {name}, but changes need a login there:</span>
      <label className="field inline"><span>User</span><input value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
      <label className="field inline"><span>Realm</span><input value={realm} onChange={(e) => setRealm(e.target.value)} required size={6} /></label>
      <label className="field inline"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
      <label className="field inline"><span>OTP</span><input value={otp} onChange={(e) => setOtp(e.target.value)} size={7} inputMode="numeric" /></label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>{busy ? 'Logging in…' : 'Log in'}</button>
      <ErrorBox message={err} />
    </form>
  );
}

function RemoveCluster({ c, onRemoved }: { c: Cluster; onRemoved: () => void }) {
  const { api } = useApp();
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!armed) return <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setArmed(true)}>Remove…</button>;
  return (
    <div className="inline-form wrap">
      <label className="field inline"><span>Type <code>{c.name}</code> to remove it from galley (the cluster itself is untouched)</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
      <button type="button" className="btn btn-sm btn-danger" disabled={typed !== c.name} onClick={async () => {
        try { await api.removeCluster(c.id); onRemoved(); } catch (e) { setErr(errMsg(e)); }
      }}>Remove</button>
      <button type="button" className="btn btn-sm" onClick={() => { setArmed(false); setTyped(''); }}>Cancel</button>
      <ErrorBox message={err} />
    </div>
  );
}

export function Clusters() {
  const { api, me, setMe } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const adding = new URLSearchParams(loc.search).get('add') === '1';
  const [clusters, setClusters] = useState<Cluster[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.clusters().then(setClusters).catch((e) => setErr(errMsg(e)));
  }, [api]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!loc.hash || !clusters) return;
    document.getElementById(`cluster-${loc.hash.slice(1)}`)?.scrollIntoView({ block: 'start' });
  }, [loc.hash, clusters]);

  const refreshMe = async () => { try { setMe(await api.me()); } catch { /* session gone */ } };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Clusters</h1>
          <div className="muted">Registered clusters, their API endpoints and pinned certificates.</div>
        </div>
        {!adding && <button type="button" className="btn btn-primary" onClick={() => nav('/clusters?add=1')}>Add cluster</button>}
      </div>
      <ErrorBox message={err} />

      {adding && (
        <section className="panel pad" aria-label="Add cluster">
          <h2 className="h2">Add a cluster</h2>
          <AddClusterForm api={api} onCancel={() => nav('/clusters')} onAdded={async () => { load(); await refreshMe(); nav('/clusters'); }} />
        </section>
      )}

      {(clusters ?? []).map((c) => {
        const authed = me.clusters.find((x) => x.id === c.id)?.authed;
        const tone = !c.status.reachable ? 'crit' : !c.status.quorate ? 'crit' : c.status.nodesOnline < c.status.nodes ? 'warn' : 'ok';
        return (
          <section key={c.id} id={`cluster-${c.id}`} className="panel pad cluster-card" aria-label={c.name}>
            <div className="cluster-head">
              <h2 className="h2"><Dot tone={tone} /> {c.name}</h2>
              <span className="muted">
                {c.status.reachable ? `${c.status.nodesOnline}/${c.status.nodes} nodes · ${c.status.quorate ? 'quorate' : 'NOT quorate'} · via ${c.status.activeEndpoint} · polled ${ago(c.status.lastPoll)}` : `unreachable${c.status.error ? `: ${c.status.error}` : ''}`}
              </span>
              <span className={authed ? 'tone-ok small' : 'tone-warn small'}>{authed ? 'logged in' : 'read-only'}</span>
            </div>
            <div className="table-box">
              <table className="table dense">
                <thead><tr><th scope="col">Endpoint</th><th scope="col">Pinned SHA-256 fingerprint</th></tr></thead>
                <tbody>
                  {c.endpoints.map((e) => (
                    <tr key={e.host}>
                      <td className="mono">{e.host}{e.host === c.status.activeEndpoint ? <span className="pill">active</span> : null}</td>
                      <td className="mono small fp">{e.fingerprint || <span className="muted">system-trusted certificate</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!authed && <ClusterLogin id={c.id} name={c.name} />}
            <div className="row-actions"><RemoveCluster c={c} onRemoved={async () => { load(); await refreshMe(); }} /></div>
          </section>
        );
      })}
    </div>
  );
}
