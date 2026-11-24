import { useEffect, useState } from 'react';
import type { Api, Cluster, Me } from '../api/types';
import { AddClusterForm } from './AddClusterForm';
import { ErrorBox, Logo } from '../components/ui';
import { errMsg } from '../state/app';

export function Setup({ api, onDone }: { api: Api; onDone: () => void }) {
  return (
    <div className="auth-page">
      <div className="auth-wide">
        <div className="auth-brand"><Logo size={28} /><span>galley</span></div>
        <h1>Connect your first cluster</h1>
        <p className="muted">galley reads cluster state with a read-only token and performs changes as whoever logs in. Nothing is stored except the endpoints, pinned certificates and the token.</p>
        <AddClusterForm api={api} onAdded={onDone} />
      </div>
    </div>
  );
}

const REALMS = ['pam', 'pve'];

export function Login({ api, onLogin }: { api: Api; onLogin: (m: Me) => void }) {
  const [clusters, setClusters] = useState<Pick<Cluster, 'id' | 'name'>[] | null>(null);
  const [clusterId, setClusterId] = useState('');
  const [username, setUsername] = useState('root');
  const [realm, setRealm] = useState('pam');
  const [customRealm, setCustomRealm] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.setup()
      .then(({ clusters: c }) => { setClusters(c); if (c[0]) setClusterId(c[0].id); })
      .catch(() => setClusters([]));
  }, [api]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      onLogin(await api.login({ clusterId, username, realm: realm === 'other' ? customRealm : realm, password, ...(otp ? { otp } : {}) }));
    } catch (e2) { setErr(errMsg(e2)); setPassword(''); } finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><Logo size={28} /><span>galley</span></div>
        <p className="muted">Log in with your Proxmox VE account. galley uses the same credentials on every registered cluster where they are valid.</p>
        {clusters && clusters.length > 0 ? (
          <label className="field"><span>Cluster</span>
            <select value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
              {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        ) : (
          <label className="field"><span>Cluster ID</span><input value={clusterId} onChange={(e) => setClusterId(e.target.value)} required /></label>
        )}
        <div className="grid-2">
          <label className="field"><span>Username</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
          <label className="field"><span>Realm</span>
            <select value={realm} onChange={(e) => setRealm(e.target.value)}>
              {REALMS.map((r) => <option key={r} value={r}>{r === 'pam' ? 'Linux PAM (pam)' : 'Proxmox VE (pve)'}</option>)}
              <option value="other">Other…</option>
            </select>
          </label>
        </div>
        {realm === 'other' && <label className="field"><span>Realm ID</span><input value={customRealm} onChange={(e) => setCustomRealm(e.target.value)} required /></label>}
        <label className="field"><span>Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        <label className="field"><span>One-time code <span className="muted">— if your account has 2FA</span></span><input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label>
        <ErrorBox message={err} />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !clusterId}>{busy ? 'Logging in…' : 'Log in'}</button>
      </form>
    </div>
  );
}
