import { useState } from 'react';
import type { Api, Cluster, Probe } from '../api/types';
import { errMsg } from '../state/app';
import { ErrorBox } from '../components/ui';

/**
 * Register a cluster: probe endpoints → confirm each TLS fingerprint (trust on first use)
 * → name + read-only service token. Shared by first-run setup and the Clusters page.
 */
export function AddClusterForm({ api, onAdded, onCancel }: { api: Api; onAdded: (c: Cluster) => void; onCancel?: () => void }) {
  const [raw, setRaw] = useState('');
  const [probes, setProbes] = useState<Probe[] | null>(null);
  const [trust, setTrust] = useState<Record<string, boolean>>({});
  const [name, setName] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [tokenSecret, setTokenSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const hosts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  const probe = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.probe(hosts);
      setProbes(r.endpoints);
      setTrust(Object.fromEntries(r.endpoints.map((p) => [p.host, p.reachable && p.trustedBySystem])));
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  const chosen = (probes ?? []).filter((p) => p.reachable && trust[p.host]);
  const canAdd = chosen.length > 0 && name.trim() && tokenId.trim() && tokenSecret.trim() && !busy;

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      const c = await api.addCluster({
        name: name.trim(),
        endpoints: chosen.map((p) => ({ host: p.host, fingerprint: p.fingerprint })),
        tokenId: tokenId.trim(),
        tokenSecret: tokenSecret.trim(),
      });
      onAdded(c);
    } catch (e) { setErr(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <div className="form-card">
      <ol className="steps-list">
        <li className={probes ? 'done' : 'current'}>
          <label className="field">
            <span>API endpoints <span className="muted">— one per line, every node of the cluster (port 8006 assumed)</span></span>
            <textarea rows={3} value={raw} onChange={(e) => { setRaw(e.target.value); setProbes(null); }} placeholder={'192.0.2.11\n192.0.2.12\n192.0.2.13'} spellCheck={false} />
          </label>
          <button type="button" className="btn" disabled={!hosts.length || busy} onClick={probe}>{busy && !probes ? 'Probing…' : 'Probe endpoints'}</button>
        </li>

        {probes && (
          <li className="current">
            <div className="field-label">Trust certificates <span className="muted">— compare with <code>pvenode cert info</code> on each node</span></div>
            <div className="table-box">
              <table className="table">
                <thead><tr><th scope="col">Trust</th><th scope="col">Endpoint</th><th scope="col">SHA-256 fingerprint</th></tr></thead>
                <tbody>
                  {probes.map((p) => (
                    <tr key={p.host}>
                      <td>
                        <input type="checkbox" aria-label={`Trust ${p.host}`} disabled={!p.reachable} checked={!!trust[p.host]}
                          onChange={(e) => setTrust((t) => ({ ...t, [p.host]: e.target.checked }))} />
                      </td>
                      <td className="mono">{p.host}</td>
                      <td className="mono small fp">
                        {!p.reachable ? <span className="tone-crit">unreachable{p.error ? `: ${p.error}` : ''}</span>
                          : p.trustedBySystem ? <span className="tone-ok">valid public certificate</span> : p.fingerprint}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </li>
        )}

        {probes && (
          <li className="current">
            <div className="grid-2">
              <label className="field"><span>Cluster name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="pve-lab" /></label>
              <span />
              <label className="field">
                <span>Service token ID <span className="muted">— read-only, PVEAuditor</span></span>
                <input value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="galley@pve!poller" className="mono" spellCheck={false} />
              </label>
              <label className="field"><span>Token secret</span><input type="password" value={tokenSecret} onChange={(e) => setTokenSecret(e.target.value)} autoComplete="off" className="mono" /></label>
            </div>
            <p className="muted small">
              The token is used only to read status for dashboards. Every change runs with your own PVE login.
              Create it with: <code>pveum user add galley@pve &amp;&amp; pveum acl modify / --users galley@pve --roles PVEAuditor &amp;&amp; pveum user token add galley@pve poller --privsep 0</code>
            </p>
          </li>
        )}
      </ol>
      <ErrorBox message={err} />
      <div className="row-actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        {probes && <button type="button" className="btn btn-primary" disabled={!canAdd} onClick={add}>{busy ? 'Adding…' : `Add cluster (${chosen.length} endpoint${chosen.length === 1 ? '' : 's'})`}</button>}
      </div>
    </div>
  );
}
