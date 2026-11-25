import { useState } from 'react';
import type { Api, Cluster, Endpoint, Probe } from '../api/types';
import { errMsg } from '../state/app';
import { ErrorBox } from '../components/ui';
import { SETUP_CODE_HELP, setupTokenMessage } from '../lib/auth';

/** Probe endpoints and let the admin confirm each certificate (trust on first use). */
export function ProbeEndpoints({ api, setupCode, initial = '', onChosen, disabled = false }: {
  api: Api; setupCode?: string; initial?: string; onChosen: (eps: Endpoint[] | null) => void; disabled?: boolean;
}) {
  const [raw, setRaw] = useState(initial);
  const [probes, setProbes] = useState<Probe[] | null>(null);
  const [trust, setTrust] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const hosts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

  const report = (ps: Probe[] | null, t: Record<string, boolean>) => {
    const chosen = (ps ?? []).filter((p) => p.reachable && t[p.host]).map((p) => ({ host: p.host, fingerprint: p.fingerprint }));
    onChosen(chosen.length ? chosen : null);
  };

  const probe = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await api.probe(hosts, setupCode);
      const t = Object.fromEntries(r.endpoints.map((p) => [p.host, p.reachable && p.trustedBySystem]));
      setProbes(r.endpoints); setTrust(t); report(r.endpoints, t);
    } catch (e) { setErr(setupTokenMessage(e) ?? `Could not probe the endpoints: ${errMsg(e)}`); } finally { setBusy(false); }
  };

  return (
    <div className="form-stack">
      <label className="field">
        <span className="label">API endpoints, one per line: every node of the cluster (port 8006 unless you add one)</span>
        <textarea rows={3} value={raw} onChange={(e) => { setRaw(e.target.value); setProbes(null); onChosen(null); }} placeholder={'192.0.2.11\n192.0.2.12\n192.0.2.13'} spellCheck={false} />
      </label>
      <div><button type="button" className="btn" disabled={!hosts.length || busy || disabled} onClick={probe}>{busy ? 'Probing' : 'Probe endpoints'}</button></div>
      {probes && (
        <div className="form-stack" style={{ gap: 8 }}>
          <div className="text-2">Trust certificates. Compare each fingerprint with <code>pvenode cert info</code> on that node.</div>
          <div className="panel table-wrap">
            <table className="table">
              <thead><tr><th scope="col">Trust</th><th scope="col">Endpoint</th><th scope="col">SHA-256 fingerprint</th></tr></thead>
              <tbody>
                {probes.map((p) => (
                  <tr key={p.host}>
                    <td>
                      <input type="checkbox" aria-label={`Trust ${p.host}`} disabled={!p.reachable} checked={!!trust[p.host]}
                        onChange={(e) => { const t = { ...trust, [p.host]: e.target.checked }; setTrust(t); report(probes, t); }} />
                    </td>
                    <td className="mono">{p.host}</td>
                    <td className="mono fp">
                      {!p.reachable ? <span className="tone-crit">Unreachable{p.error ? `: ${p.error}` : ''}</span>
                        : p.trustedBySystem ? <span className="tone-ok">Valid public certificate</span> : p.fingerprint}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <ErrorBox message={err} />
    </div>
  );
}

/**
 * Register a cluster: probe endpoints, confirm each TLS fingerprint, then name + read-only
 * service token. Shared by first-run setup and the Clusters page. In first-run setup the
 * installer's one-time setup code is sent as X-Galley-Setup-Token on the probe and add calls.
 */
export function AddClusterForm({ api, onAdded, onCancel, setup = false }: {
  api: Api; onAdded: (c: Cluster) => void; onCancel?: () => void; setup?: boolean;
}) {
  const [setupCode, setSetupCode] = useState('');
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [name, setName] = useState('');
  const [tokenId, setTokenId] = useState('');
  const [tokenSecret, setTokenSecret] = useState('');
  const [shareLogin, setShareLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const code = setup ? setupCode.trim() || undefined : undefined;
  const canAdd = (!setup || !!code) && !!endpoints && name.trim() && tokenId.trim() && tokenSecret.trim() && !busy;

  const add = async () => {
    if (!endpoints) return;
    setBusy(true); setErr(null);
    try {
      onAdded(await api.addCluster({ name: name.trim(), endpoints, tokenId: tokenId.trim(), tokenSecret: tokenSecret.trim(), ...(shareLogin ? { shareLogin } : {}) }, code));
    } catch (e) { setErr(setupTokenMessage(e) ?? `Could not add the cluster: ${errMsg(e)}`); } finally { setBusy(false); }
  };

  return (
    <div className="form-stack">
      <ol className="steps-list">
        {setup && (
          <li className={code ? 'done' : 'current'}>
            <label className="field">
              <span className="label">Setup code</span>
              <input value={setupCode} onChange={(e) => setSetupCode(e.target.value)} className="mono" autoComplete="off" spellCheck={false} required />
              <span className="hint">{SETUP_CODE_HELP}</span>
            </label>
          </li>
        )}
        <li className={endpoints ? 'done' : 'current'}>
          <ProbeEndpoints api={api} setupCode={code} onChosen={setEndpoints} disabled={setup && !code} />
        </li>
        {endpoints && (
          <li className="current">
            <div className="form-row">
              <label className="field"><span className="label">Cluster name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="pve-lab" /></label>
            </div>
            <div className="form-row">
              <label className="field"><span className="label">Service token ID (read-only, PVEAuditor)</span>
                <input value={tokenId} onChange={(e) => setTokenId(e.target.value)} placeholder="galley@pve!poller" className="mono" spellCheck={false} />
              </label>
              <label className="field"><span className="label">Token secret</span><input type="password" value={tokenSecret} onChange={(e) => setTokenSecret(e.target.value)} autoComplete="off" className="mono" /></label>
            </div>
            {!setup && (
              <label className="check"><input type="checkbox" checked={shareLogin} onChange={(e) => setShareLogin(e.target.checked)} />
                Share logins with other clusters that share this setting (same realm, for example LDAP or AD)</label>
            )}
            <p className="muted small">
              The token only reads status for dashboards. Every change runs with your own PVE login. Create it with:
            </p>
            <pre className="cli">pveum user add galley@pve{'\n'}pveum acl modify / --users galley@pve --roles PVEAuditor{'\n'}pveum user token add galley@pve poller --privsep 0</pre>
          </li>
        )}
      </ol>
      <ErrorBox message={err} />
      <div className="row-actions">
        {onCancel && <button type="button" className="btn" onClick={onCancel}>Cancel</button>}
        {endpoints && <button type="button" className="btn btn-primary" disabled={!canAdd} onClick={add}>{busy ? 'Adding' : `Add cluster with ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}`}</button>}
      </div>
    </div>
  );
}
