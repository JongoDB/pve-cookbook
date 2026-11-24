import { useState } from 'react';
import { ApiError } from '../api/http';
import type { HostNode, HostScan } from '../api/types';
import { errMsg, useApp, useCrumbs } from '../state/app';
import { useAsync } from '../lib/hooks';
import { ago } from '../lib/format';
import { ApiErrorView, ClusterLoginForm } from '../components/ClusterLogin';
import { Badge, CopyButton, Empty, Status } from '../components/ui';

export const HOSTS_EXPLAIN = 'For what the PVE API cannot do: NIC flow control, kernel parameters, disks, packages. Commands run as root on the node, only after you apply them in Changes, and their output is kept in the audit log.';

export function Hosts() {
  useCrumbs([{ label: 'Hosts' }]);
  const { me } = useApp();
  const admin = me.clusters.filter((c) => c.admin);
  const shown = admin.length ? admin : me.clusters;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Hosts</h1>
        <div className="sub">{HOSTS_EXPLAIN}</div>
      </div>
      {!admin.length && <div className="notice notice-info"><div className="grow">Host commands need administrator rights on / of a cluster (Sys.Modify, Sys.Console and Permissions.Modify). PVE does not report them for your account on any cluster.</div></div>}
      {shown.map((c) => <ClusterHosts key={c.id} clusterId={c.id} />)}
    </div>
  );
}

function ClusterHosts({ clusterId }: { clusterId: string }) {
  const { api, me, clusterName } = useApp();
  const authed = !!me.clusters.find((c) => c.id === clusterId)?.authed;
  const [rev, setRev] = useState(0);
  const hosts = useAsync(authed ? () => api.hosts(clusterId) : null, `hosts|${clusterId}|${authed}|${rev}`);
  const name = clusterName(clusterId);
  const reload = () => setRev((r) => r + 1);
  const isRootPam = me.user === 'root@pam';

  return (
    <section className="panel" aria-labelledby={`hosts-${clusterId}`}>
      <div className="panel-head"><h2 id={`hosts-${clusterId}`}>{name}</h2>
        {hosts.data && <span className="muted">{hosts.data.transport === 'ssh' ? `galley's SSH key, ${hosts.data.nodes.filter((n) => n.pin).length} of ${hosts.data.nodes.length} nodes pinned` : "PVE's node terminal"}</span>}</div>
      {!authed ? <div className="panel-body"><ClusterLoginForm clusterId={clusterId} compact /></div>
        : hosts.error ? (
          <div className="panel-body">
            {hosts.error instanceof ApiError && hosts.error.status === 403
              ? <Empty title={`No host access on ${name}`}>{hosts.error.message}. galley asks PVE: your account needs Sys.Modify, Sys.Console and Permissions.Modify on / of {name}.</Empty>
              : <ApiErrorView error={hosts.error} clusterId={clusterId} onRetry={hosts.reload} what="the hosts" />}
          </div>
        ) : !hosts.data ? <div className="muted panel-body" role="status">Loading hosts</div> : hosts.data.transport === 'ssh' ? (
          <>
            <div className="panel-body form-stack">
              <div>
                <div className="section-label">galley&apos;s SSH key for {name}</div>
                <p className="small text-2">Run this once, as root, on any node of {name}. <span className="mono">/etc/pve/priv/authorized_keys</span> lives on the cluster file system and every node&apos;s <span className="mono">/root/.ssh/authorized_keys</span> links to it, so all nodes trust the key at once. The <span className="mono">restrict</span> option turns off forwarding, agents and X11 for it. galley uses a separate key for every cluster.</p>
              </div>
              {hosts.data.install && <pre className="cli">{hosts.data.install}</pre>}
              <div className="row-actions">
                {hosts.data.install && <CopyButton text={hosts.data.install} label="Copy install command" />}
                {hosts.data.authorizedKey && <CopyButton text={hosts.data.authorizedKey} label="Copy public key only" />}
              </div>
            </div>
            <ul className="host-list">
              {hosts.data.nodes.map((n) => <HostRow key={n.node} clusterId={clusterId} n={n} ssh onChanged={reload} />)}
            </ul>
          </>
        ) : (
          <>
            <div className="panel-body form-stack">
              <p className="small text-2">{hosts.data.note ?? "Host commands run in PVE's node terminal as the acting user."} galley stores no SSH key for {name}.</p>
              {!isRootPam && (
                <div className="notice notice-info"><div className="grow">Host commands need a root@pam login: PVE gives a passwordless root shell only to root@pam, and you are logged in as {me.user}. Log in to galley as root@pam, or have a galley admin switch {name} to the SSH transport on the Clusters page.</div></div>
              )}
            </div>
            <ul className="host-list">
              {hosts.data.nodes.map((n) => <HostRow key={n.node} clusterId={clusterId} n={n} ssh={false} onChanged={reload} />)}
            </ul>
          </>
        )}
    </section>
  );
}

const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;

function HostRow({ clusterId, n, ssh, onChanged }: { clusterId: string; n: HostNode; ssh: boolean; onChanged: () => void }) {
  const { api, openPlan } = useApp();
  const [scan, setScan] = useState<HostScan | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState<'scan' | 'pin' | 'unpin' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmUnpin, setConfirmUnpin] = useState(false);
  const [cmd, setCmd] = useState('');
  const [reason, setReason] = useState('');
  const [cmdOpen, setCmdOpen] = useState(false);

  const doScan = async () => {
    setBusy('scan'); setErr(null); setTyped('');
    try { setScan(await api.scanHost(clusterId, n.node)); } catch (e) { setErr(`Could not read the host key of ${n.node}: ${errMsg(e)}`); } finally { setBusy(null); }
  };
  const pin = async () => {
    setBusy('pin'); setErr(null);
    try { await api.pinHost(clusterId, n.node, typed.trim()); setScan(null); setTyped(''); onChanged(); } catch (e) {
      setErr(e instanceof ApiError && e.code === 'fingerprint_mismatch' ? `Not pinned: ${e.message}. Check that you ran the command on ${n.node} itself.` : `Could not pin: ${errMsg(e)}`);
    } finally { setBusy(null); }
  };
  const unpin = async () => {
    setBusy('unpin'); setErr(null);
    try { await api.unpinHost(clusterId, n.node); setConfirmUnpin(false); onChanged(); } catch (e) { setErr(`Could not unpin: ${errMsg(e)}`); } finally { setBusy(null); }
  };
  const typedOk = FP_RE.test(typed.trim());
  const matches = !!scan && typed.trim() === scan.fingerprint;

  return (
    <li className="host">
      <div className="host-head">
        <span className="host-name strong">{n.node}</span>
        <Status tone={n.online ? 'ok' : 'crit'}>{n.online ? 'online' : 'offline'}</Status>
        {ssh && (n.pin ? <Badge kind="ok">Host key pinned</Badge> : <Badge kind="neutral">Not pinned</Badge>)}
        <span className="spacer" />
        {(n.pin || !ssh) && <button type="button" className="btn btn-sm" aria-expanded={cmdOpen} onClick={() => setCmdOpen((v) => !v)}>Run a command</button>}
        {ssh && !n.pin && <button type="button" className="btn btn-sm" disabled={busy === 'scan'} onClick={() => void doScan()}>{busy === 'scan' ? 'Reading host key' : 'Read host key'}</button>}
        {n.pin && !confirmUnpin && <button type="button" className="btn btn-sm" onClick={() => setConfirmUnpin(true)}>Unpin</button>}
        {n.pin && confirmUnpin && <>
          <button type="button" className="btn btn-sm btn-danger-outline" disabled={busy === 'unpin'} onClick={() => void unpin()}>Unpin {n.node}</button>
          <button type="button" className="btn btn-sm" onClick={() => setConfirmUnpin(false)}>Keep</button>
        </>}
      </div>
      {n.pin && (
        <div className="ws host-pin">
          <span className="mono">{n.pin.fingerprint}</span> at <span className="mono">{n.pin.addr}</span>, pinned by {n.pin.pinnedBy} {ago(n.pin.pinnedAt)}
          {confirmUnpin && <div className="tone-warn">Unpinning stops all host commands on {n.node} until you pin it again.</div>}
        </div>
      )}
      {scan && !n.pin && (
        <div className="host-scan form-stack">
          <div className="small">{n.node} at <span className="mono">{scan.addr}</span> presents:</div>
          <pre className="cli">{scan.fingerprint}</pre>
          <div className="small text-2">Before you trust it, log in to {n.node} through a path you already trust (PVE shell, IPMI, or the console) and run:</div>
          <pre className="cli">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</pre>
          <div className="row-actions"><CopyButton text="ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub" label="Copy command" /></div>
          <label className="field">
            <span className="label">Fingerprint you saw on {n.node}</span>
            <input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="SHA256:…" spellCheck={false} autoComplete="off" className="mono" />
            {typed && !typedOk && <span className="hint">Paste the SHA256:… part of the output (43 characters after the colon).</span>}
            {typedOk && !matches && <span className="tone-crit small" role="alert">This does not match what {scan.addr} presents. Do not pin: something other than {n.node} may be answering at that address.</span>}
            {matches && <span className="tone-ok small">Matches.</span>}
          </label>
          <div className="row-actions">
            <button type="button" className="btn btn-primary" disabled={!matches || busy === 'pin'} onClick={() => void pin()}>{busy === 'pin' ? 'Pinning' : `Pin ${n.node}`}</button>
            <button type="button" className="btn" onClick={() => { setScan(null); setTyped(''); }}>Cancel</button>
            <span className="muted small">galley reads the key again from the node&apos;s cluster address and pins it only if it still matches.</span>
          </div>
        </div>
      )}
      {cmdOpen && (n.pin || !ssh) && (
        <form className="host-cmd form-stack" onSubmit={(e) => {
          e.preventDefault();
          if (!cmd.trim()) return;
          void openPlan({ action: 'host.exec', clusterId, params: { node: n.node, command: cmd.trim(), ...(reason.trim() ? { reason: reason.trim() } : {}) } });
          setCmdOpen(false); setCmd(''); setReason('');
        }}>
          <label className="field"><span className="label">Command (bash -c, as root on {n.node}{ssh ? ", over galley's SSH key" : ", in PVE's node terminal"}; no input, 30 minute limit)</span>
            <textarea rows={4} value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="ethtool -A enp65s0f0 rx off tx off" spellCheck={false} required /></label>
          <label className="field"><span className="label">Reason (kept in the audit log)</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Turn off flow control on the SFP+ uplink" /></label>
          <div className="row-actions">
            <button type="submit" className="btn btn-primary" disabled={!cmd.trim()}>Review command</button>
            <button type="button" className="btn" onClick={() => setCmdOpen(false)}>Cancel</button>
            <span className="muted small">Opens in Changes. You confirm it by typing <code>run on {n.node}</code>.</span>
          </div>
        </form>
      )}
      {err && <div className="notice notice-error" role="alert"><div className="grow">{err}</div></div>}
    </li>
  );
}
