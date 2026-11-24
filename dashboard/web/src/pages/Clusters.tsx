import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { Cluster, Endpoint } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { AddClusterForm, ProbeEndpoints } from './AddClusterForm';
import { ClusterLoginForm } from '../components/ClusterLogin';
import { Badge, ErrorBox } from '../components/ui';
import { ago } from '../lib/format';

function Rename({ c, onDone }: { c: Cluster; onDone: () => void }) {
  const { api, refreshMe } = useApp();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(c.name);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Rename</button>;
  return (
    <form className="inline-form" style={{ flexBasis: '100%' }} onSubmit={async (e) => {
      e.preventDefault(); setErr(null);
      try { await api.updateCluster(c.id, { name: name.trim() }); setOpen(false); await refreshMe(); onDone(); } catch (e2) { setErr(`Could not rename: ${errMsg(e2)}`); }
    }}>
      <label className="field"><span className="label">New name for {c.name}</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus maxLength={63} /></label>
      <button type="submit" className="btn btn-primary" disabled={!name.trim() || name.trim() === c.name}>Rename cluster</button>
      <button type="button" className="btn" onClick={() => { setOpen(false); setName(c.name); }}>Cancel</button>
      {err && <span className="tone-crit" role="alert" style={{ flexBasis: '100%' }}>{err}</span>}
    </form>
  );
}

function Endpoints({ c, onDone }: { c: Cluster; onDone: () => void }) {
  const { api } = useApp();
  const [open, setOpen] = useState(false);
  const [eps, setEps] = useState<Endpoint[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!open) return <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>Update endpoints</button>;
  return (
    <div className="inline-form" style={{ flexBasis: '100%', display: 'block' }}>
      <p className="text-2" style={{ marginBottom: 10 }}>Probe the nodes again after adding a node or renewing a certificate. galley checks the cluster answers at the new endpoints before saving them.</p>
      <ProbeEndpoints api={api} initial={(c.endpoints ?? []).map((e) => e.host).join('\n')} onChosen={setEps} />
      <div className="row-actions" style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" disabled={!eps || busy} onClick={async () => {
          if (!eps) return;
          setBusy(true); setErr(null);
          try { await api.updateCluster(c.id, { endpoints: eps }); setOpen(false); onDone(); } catch (e) { setErr(`Could not save the endpoints: ${errMsg(e)}`); } finally { setBusy(false); }
        }}>{busy ? 'Saving' : `Save ${eps?.length ?? 0} endpoint${eps?.length === 1 ? '' : 's'}`}</button>
        <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      <ErrorBox message={err} />
    </div>
  );
}

function ShareLogin({ c, onDone }: { c: Cluster; onDone: () => void }) {
  const { api } = useApp();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ flexBasis: '100%' }}>
      <label className="check">
        <input type="checkbox" checked={!!c.shareLogin} disabled={busy} onChange={async (e) => {
          setBusy(true); setErr(null);
          try { await api.updateCluster(c.id, { shareLogin: e.target.checked }); onDone(); } catch (e2) { setErr(`Could not change login sharing: ${errMsg(e2)}`); } finally { setBusy(false); }
        }} />
        Share logins with other clusters that have this on (only for clusters on the same realm, such as LDAP or AD)
      </label>
      <ErrorBox message={err} />
    </div>
  );
}

function RemoveCluster({ c, onRemoved }: { c: Cluster; onRemoved: () => void }) {
  const { api } = useApp();
  const [armed, setArmed] = useState(false);
  const [typed, setTyped] = useState('');
  const [err, setErr] = useState<string | null>(null);
  if (!armed) return <button type="button" className="btn btn-sm btn-danger-outline" onClick={() => setArmed(true)}>Remove from galley</button>;
  return (
    <div className="inline-form" style={{ flexBasis: '100%' }}>
      <label className="field"><span className="label">Type <code>{c.name}</code> to remove it from galley. The cluster itself is not touched.</span>
        <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </label>
      <button type="button" className="btn btn-danger" disabled={typed !== c.name} onClick={async () => {
        try { await api.removeCluster(c.id); onRemoved(); } catch (e) { setErr(`Could not remove: ${errMsg(e)}`); }
      }}>Remove {c.name}</button>
      <button type="button" className="btn" onClick={() => { setArmed(false); setTyped(''); }}>Cancel</button>
      <ErrorBox message={err} />
    </div>
  );
}

export function Clusters() {
  useCrumbs([{ label: 'Clusters' }]);
  const { api, me, refreshMe } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const adding = new URLSearchParams(loc.search).get('add') === '1' && !!me.galleyAdmin;
  const [clusters, setClusters] = useState<Cluster[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(() => {
    api.clusters().then((c) => { setClusters(c); setErr(null); }).catch((e) => setErr(`Could not load clusters: ${errMsg(e)}`));
  }, [api]);
  useEffect(() => { load(); }, [load, me]);

  useEffect(() => {
    if (!loc.hash || !clusters) return;
    document.getElementById(`cluster-${decodeURIComponent(loc.hash.slice(1))}`)?.scrollIntoView({ block: 'start' });
  }, [loc.hash, clusters]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Clusters</h1>
        {me.galleyAdmin && !adding && <button type="button" className="btn btn-primary" onClick={() => nav('/clusters?add=1')}>Add cluster</button>}
      </div>
      <ErrorBox message={err} />

      {adding && (
        <section className="panel" aria-labelledby="add-h">
          <div className="panel-head"><h2 id="add-h">Add a cluster</h2></div>
          <div className="panel-body"><AddClusterForm api={api} onCancel={() => nav('/clusters')} onAdded={async () => { load(); await refreshMe(); nav('/clusters'); }} /></div>
        </section>
      )}

      {clusters === null && !err && <div className="muted" role="status">Loading clusters</div>}
      {(clusters ?? []).map((c) => {
        const mine = me.clusters.find((x) => x.id === c.id);
        const authed = !!mine?.authed;
        const admin = !!(mine?.admin ?? c.admin);
        const st = c.status;
        const badge = !st.reachable ? <Badge kind="crit">Unreachable</Badge> : !st.quorate ? <Badge kind="crit">Not quorate</Badge>
          : st.nodes !== undefined && st.nodesOnline !== undefined && st.nodesOnline < st.nodes ? <Badge kind="warn">{st.nodes - st.nodesOnline} node{st.nodes - st.nodesOnline === 1 ? '' : 's'} offline</Badge>
            : <Badge kind="ok">Healthy</Badge>;
        return (
          <section key={c.id} id={`cluster-${c.id}`} className="panel" aria-labelledby={`ch-${c.id}`}>
            <div className="panel-head">
              <h2 id={`ch-${c.id}`}>{c.name}</h2>
              {badge}
              <Badge kind={authed ? 'neutral' : 'warn'}>{authed ? (admin ? 'Logged in, admin' : 'Logged in') : 'Not logged in'}</Badge>
            </div>
            <div className="panel-body form-stack">
              <div className="text-2">
                {st.reachable
                  ? <>{st.nodes !== undefined ? `${st.nodesOnline} of ${st.nodes} nodes online` : 'Reachable'}{st.activeEndpoint ? `, via ${st.activeEndpoint}` : ''}, polled {ago(st.lastPoll)}</>
                  : <>galley cannot reach {c.name}{st.error ? `: ${st.error}` : ''}. Check the network path and the endpoints below.</>}
                {c.brokenSecret ? <div className="tone-crit">The stored token secret cannot be decrypted (was secret.key replaced?). Remove and add the cluster again.</div> : null}
              </div>
              {c.endpoints && (
                <div className="panel table-wrap" style={{ background: 'var(--bg)' }}>
                  <table className="table dense">
                    <thead><tr><th scope="col">Endpoint</th><th scope="col">Pinned SHA-256 fingerprint</th></tr></thead>
                    <tbody>
                      {c.endpoints.map((e) => (
                        <tr key={e.host}>
                          <td className="mono nowrap">{e.host}{e.host === st.activeEndpoint ? <span className="badge badge-ok" style={{ marginLeft: 8 }}>Active</span> : null}</td>
                          <td className="mono fp">{e.fingerprint || <span className="muted">System-trusted certificate</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {c.tokenId && <div className="muted small">Read-only service token <code>{c.tokenId}</code>{c.shareLogin ? '. Logins are shared with other clusters that allow it.' : ''}</div>}
              {!authed && <ClusterLoginForm clusterId={c.id} onDone={load} />}
              <div className="row-actions">
                {admin && <Rename c={c} onDone={load} />}
                {me.galleyAdmin && <Endpoints c={c} onDone={load} />}
                {(admin || me.galleyAdmin) && <RemoveCluster c={c} onRemoved={async () => { load(); await refreshMe(); }} />}
              </div>
              {me.galleyAdmin && <ShareLogin c={c} onDone={load} />}
            </div>
          </section>
        );
      })}
    </div>
  );
}
