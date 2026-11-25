import { useState } from 'react';
import { ApiError } from '../api/http';
import { errMsg, useApp } from '../state/app';
import { rateLimitMessage, rateLimitedUntil, secondsLeft } from '../lib/auth';

/**
 * Adds a login for one more cluster to this session. The identity is fixed to the
 * session's user (one session = one identity); only the password and second factor are asked.
 */
export function ClusterLoginForm({ clusterId, onDone, compact = false }: { clusterId: string; onDone?: () => void; compact?: boolean }) {
  const { api, me, setMe, clusterName } = useApp();
  const name = clusterName(clusterId);
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const idp = `cl-${clusterId}`;
  const lapsed = !!me.clusters.find((c) => c.id === clusterId)?.loginExpired;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (secondsLeft(lockedUntil) > 0) return;
    setBusy(true); setErr(null);
    try {
      const m = await api.clusterLogin(clusterId, { password, ...(otp ? { otp } : {}) });
      setMe(m);
      onDone?.();
    } catch (e2) {
      const until = rateLimitedUntil(e2);
      if (until) { setLockedUntil(until); setErr(rateLimitMessage(secondsLeft(until))); }
      else if (e2 instanceof ApiError && e2.code === 'otp_required') setErr('This account needs a one-time code. Enter it and log in again.');
      else if (e2 instanceof ApiError && e2.code === 'credential_failed') setErr(`Your password was accepted, but ${name} refused to create the session token: ${e2.message}. Ask a galley admin to check the cluster's login mode, or your PVE rights.`);
      else setErr(`Could not log in to ${name}: ${errMsg(e2)}. Check the password for ${me.user}.`);
      setPassword('');
    } finally { setBusy(false); }
  };

  return (
    <form className={compact ? 'form-stack' : 'inline-form'} onSubmit={submit} aria-label={`Log in to ${name}`}>
      <p className="text-2" style={compact ? undefined : { flexBasis: '100%' }}>
        {lapsed
          ? <>Your login to {name} lapsed while you were away. Enter the password for <strong>{me.user}</strong> to continue; nothing else in galley is affected.</>
          : <>You are not logged in to {name} in this session. Log in as <strong>{me.user}</strong> to see and change it.</>}
      </p>
      <label className="field" htmlFor={`${idp}-pw`}>
        <span className="label">Password</span>
        <input id={`${idp}-pw`} type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
      </label>
      <label className="field" htmlFor={`${idp}-otp`}>
        <span className="label">One-time code, if your account has 2FA</span>
        <input id={`${idp}-otp`} value={otp} onChange={(e) => setOtp(e.target.value)} inputMode="numeric" autoComplete="one-time-code" />
      </label>
      <button type="submit" className="btn btn-primary" disabled={busy || secondsLeft(lockedUntil) > 0}>{busy ? 'Logging in' : `Log in to ${name}`}</button>
      {err && <div className="notice notice-error" role="alert" style={{ flexBasis: '100%' }}>{err}</div>}
    </form>
  );
}

/**
 * Shows an API error the way the admin can act on it: a 409 cluster_login_required becomes an
 * inline login form for that cluster; anything else is a plain message with an optional retry.
 */
export function ApiErrorView({ error, clusterId, onRetry, what }: { error: unknown; clusterId?: string; onRetry?: () => void; what?: string }) {
  if (!error) return null;
  if (error instanceof ApiError && error.code === 'cluster_login_required' && clusterId) {
    return <div className="panel panel-body"><ClusterLoginForm clusterId={clusterId} onDone={onRetry} compact /></div>;
  }
  const status = error instanceof ApiError ? error.status : 0;
  const hint = status === 403 ? ' Your PVE account does not have permission for this. Ask an administrator for the privilege named above.'
    : status === 502 || status === 504 ? ' The cluster did not answer. Check that it is reachable, then retry.'
      : status === 0 || status >= 500 ? ' Retry in a moment; if it keeps failing, check the galley log.' : '';
  return (
    <div className="notice notice-error" role="alert">
      <div className="grow">{what ? `Could not load ${what}: ` : ''}{errMsg(error).replace(/\.$/, '')}.{hint}</div>
      {onRetry && <button type="button" className="btn btn-sm" onClick={onRetry}>Retry</button>}
    </div>
  );
}
