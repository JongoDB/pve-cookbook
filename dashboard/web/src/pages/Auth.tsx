import { useEffect, useState } from 'react';
import { ApiError } from '../api/http';
import type { Api, Me, Realm } from '../api/types';
import { AddClusterForm } from './AddClusterForm';
import { ErrorBox, Logo } from '../components/ui';
import { errMsg } from '../state/app';
import { rateLimitMessage, rateLimitedUntil, secondsLeft } from '../lib/auth';

export function Setup({ api, onDone }: { api: Api; onDone: () => void }) {
  return (
    <main className="auth-page">
      <div className="auth-wide">
        <div className="auth-brand"><Logo size={28} /><span>galley</span></div>
        <h1>Connect your first cluster</h1>
        <p className="text-2">galley reads cluster state with a read-only token and makes changes as whoever logs in. It stores the endpoints, their pinned certificates and the token, nothing else.</p>
        <div className="panel panel-body"><AddClusterForm api={api} onAdded={onDone} setup /></div>
      </div>
    </main>
  );
}

const FALLBACK_REALMS: Realm[] = [
  { realm: 'pam', type: 'pam', comment: 'Linux PAM standard authentication' },
  { realm: 'pve', type: 'pve', comment: 'Proxmox VE authentication server' },
];

/** `?loginError=` set by the OpenID callback; read once and removed from the address bar. */
function takeLoginError(): string | null {
  try {
    const u = new URL(window.location.href);
    const e = u.searchParams.get('loginError');
    if (e === null) return null;
    u.searchParams.delete('loginError');
    window.history.replaceState(null, '', u.pathname + (u.search ? u.search : '') + u.hash);
    return e || 'Single sign-on did not complete.';
  } catch { return null; }
}

export function Login({ api, onLogin, notice }: { api: Api; onLogin: (m: Me) => void; notice?: string | null }) {
  const [clusters, setClusters] = useState<{ id: string; name: string }[] | null>(null);
  const [clusterId, setClusterId] = useState('');
  const [realms, setRealms] = useState<Realm[] | null>(null);
  const [realmErr, setRealmErr] = useState<string | null>(null);
  const [username, setUsername] = useState('root');
  const [realm, setRealm] = useState('pam');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [sso, setSso] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // In an effect (not a state initializer): StrictMode runs initializers twice, and the
  // first run already removed the parameter from the address bar.
  useEffect(() => {
    const e = takeLoginError();
    if (e) setErr(`Single sign-on failed: ${e}`);
  }, []);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const [, setTick] = useState(0);
  const left = secondsLeft(lockedUntil);

  // Count the rate-limit lockout down once a second, then unlock.
  useEffect(() => {
    if (!lockedUntil) return;
    const t = setInterval(() => {
      if (secondsLeft(lockedUntil) <= 0) { setLockedUntil(null); setErr(null); } else setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [lockedUntil]);

  useEffect(() => {
    api.setup()
      .then(({ clusters: c }) => { setClusters(c); if (c[0]) setClusterId(c[0].id); })
      .catch((e) => { setClusters([]); setErr(`Cannot list clusters: ${errMsg(e)}. Enter the cluster ID by hand.`); });
  }, [api]);

  useEffect(() => {
    if (!clusterId) return;
    let alive = true;
    setRealms(null); setRealmErr(null);
    api.realms(clusterId).then(
      (r) => {
        if (!alive) return;
        const list = r.length ? r : FALLBACK_REALMS;
        setRealms(list);
        setRealm((cur) => (list.some((x) => x.realm === cur && x.type !== 'openid') ? cur : list.find((x) => x.type !== 'openid')?.realm ?? 'pam'));
      },
      (e) => {
        if (!alive) return;
        setRealms(FALLBACK_REALMS);
        setRealmErr(e instanceof ApiError && e.status === 429 ? 'Too many requests; showing the default realms.' : `Could not read this cluster's realms (${errMsg(e)}); showing the defaults.`);
      },
    );
    return () => { alive = false; };
  }, [api, clusterId]);

  const passwordRealms = (realms ?? FALLBACK_REALMS).filter((r) => r.type !== 'openid');
  const openid = (realms ?? []).filter((r) => r.type === 'openid');

  const fail = (e2: unknown) => {
    const until = rateLimitedUntil(e2);
    if (until) { setLockedUntil(until); setErr(null); return; }
    if (e2 instanceof ApiError && e2.code === 'otp_required') setErr('This account needs a one-time code. Enter it and log in again.');
    else if (e2 instanceof ApiError && (e2.status === 401 || e2.code === 'login_failed')) setErr('Wrong user name, realm or password. Check them and try again.');
    else setErr(`Could not log in: ${errMsg(e2)}`);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (secondsLeft(lockedUntil) > 0) return;
    setBusy(true); setErr(null);
    try {
      onLogin(await api.login({ clusterId, username, realm, password, ...(otp ? { otp } : {}) }));
    } catch (e2) { fail(e2); setPassword(''); } finally { setBusy(false); }
  };

  const startSso = async (r: Realm) => {
    setSso(r.realm); setErr(null);
    try {
      const { authUrl } = await api.openidLogin(clusterId, r.realm);
      window.location.assign(authUrl);
    } catch (e2) { fail(e2); setSso(null); }
  };

  const clusterName = clusters?.find((c) => c.id === clusterId)?.name ?? clusterId;

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit} aria-labelledby="login-h">
        <div className="auth-brand"><Logo size={28} /><span>galley</span></div>
        <h1 id="login-h" className="sr-only">Log in to galley</h1>
        {notice && <div className="notice notice-warn" role="status"><div className="grow">{notice}</div></div>}
        <p className="text-2">Log in with your Proxmox VE account. galley acts as you, with your PVE permissions.</p>
        {clusters && clusters.length > 0 ? (
          <label className="field"><span className="label">Cluster</span>
            <select value={clusterId} onChange={(e) => setClusterId(e.target.value)}>
              {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        ) : (
          <label className="field"><span className="label">Cluster ID</span><input value={clusterId} onChange={(e) => setClusterId(e.target.value)} required /></label>
        )}

        {openid.map((r) => (
          <button key={r.realm} type="button" className="btn btn-lg btn-block" disabled={!!sso || left > 0} onClick={() => void startSso(r)}>
            {sso === r.realm ? 'Opening your identity provider' : `Sign in with ${r.comment?.trim() || r.realm}`}
          </button>
        ))}
        {openid.length > 0 && <div className="divider">or with a password</div>}

        <div className="form-row">
          <label className="field"><span className="label">User name</span><input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required /></label>
          <label className="field"><span className="label">Realm</span>
            <select value={realm} onChange={(e) => setRealm(e.target.value)} disabled={!realms}>
              {passwordRealms.map((r) => <option key={r.realm} value={r.realm}>{r.comment ? `${r.comment} (${r.realm})` : r.realm}</option>)}
            </select>
          </label>
        </div>
        {realmErr && <div className="muted small">{realmErr}</div>}
        <label className="field"><span className="label">Password</span><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        <label className="field"><span className="label">One-time code, if your account has 2FA</span><input value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" /></label>
        <ErrorBox message={left > 0 ? rateLimitMessage(left) : err} />
        <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={busy || !clusterId || left > 0}>{busy ? 'Logging in' : clusterName ? `Log in to ${clusterName}` : 'Log in'}</button>
        <p className="muted small">A recovery code works in the one-time code field as <code>recovery:&lt;code&gt;</code>.</p>
      </form>
    </main>
  );
}
