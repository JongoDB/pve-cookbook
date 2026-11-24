import { Fragment, useMemo, useRef, useState } from 'react';
import { ApiError } from '../api/http';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Guest, GuestTarget } from '../api/types';
import { useApp, useCrumbs, errMsg } from '../state/app';
import { usePve } from '../lib/hooks';
import { clock, uptime } from '../lib/format';
import { formatBytes, formatPct } from '../lib/units';
import { describeDisk, describeNic, describePci, parseGuestConfig, type RawConfig } from '../lib/guestConfig';
import { nodePath, storagePath } from '../lib/links';
import type { GuestAction } from '../lib/actions';
import { MetricChart } from '../components/MetricChart';
import { ApiErrorView } from '../components/ClusterLogin';
import { Badge, Empty, Status } from '../components/ui';
import { ResourceEditor } from '../components/ResourceEditor';
import { consolePath } from '../lib/links';
import { TimeRange } from './Overview';
import type { Timeframe } from '../api/types';

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'hardware', label: 'Hardware' },
  { id: 'options', label: 'Options' },
  { id: 'snapshots', label: 'Snapshots' },
  { id: 'tasks', label: 'Task history' },
] as const;
type TabId = (typeof TABS)[number]['id'];

export const guestTone = (s: string) => (s === 'running' ? 'ok' : s === 'paused' || s === 'suspended' ? 'warn' : 'off');
const kindName = (g: Guest) => (g.type === 'qemu' ? 'VM' : 'Container');

/** Tabs with arrow-key navigation (WAI-ARIA tabs pattern). */
export function Tabs<T extends string>({ tabs, value, onChange, label, idPrefix }: {
  tabs: readonly { id: T; label: string }[]; value: T; onChange: (t: T) => void; label: string; idPrefix: string;
}) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t, i) => (
        <button
          key={t.id}
          ref={(el) => { refs.current[t.id] = el; }}
          type="button" role="tab" id={`${idPrefix}-tab-${t.id}`} aria-controls={`${idPrefix}-panel`}
          aria-selected={value === t.id} tabIndex={value === t.id ? 0 : -1}
          onClick={() => onChange(t.id)}
          onKeyDown={(e) => {
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const n = tabs[(i + d + tabs.length) % tabs.length];
            onChange(n.id);
            refs.current[n.id]?.focus();
          }}
        >{t.label}</button>
      ))}
    </div>
  );
}

function GuestActions({ g }: { g: Guest }) {
  const { api, openPlan, me, clusterName } = useApp();
  const [mode, setMode] = useState<null | 'migrate' | 'snapshot'>(null);
  const [targets, setTargets] = useState<string[] | null>(null);
  const [target, setTarget] = useState('');
  const [snap, setSnap] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const authed = !!me.clusters.find((c) => c.id === g.clusterId)?.authed;
  const t: GuestTarget = { vmid: g.vmid, node: g.node, type: g.type };
  const plan = (action: GuestAction, extra: Record<string, unknown> = {}) => {
    setMode(null);
    void openPlan({ action, clusterId: g.clusterId, params: { targets: [t], ...extra } });
  };
  const running = g.status === 'running';
  const why = authed ? undefined : `Log in to ${clusterName(g.clusterId)} first`;
  const startMigrate = async () => {
    setMode('migrate'); setTargets(null); setErr(null);
    try { const l = await api.targets(g.clusterId, g.node); setTargets(l); setTarget(l[0] ?? ''); } catch (e) { setErr(`Could not list migration targets: ${errMsg(e)}`); }
  };
  return (
    <>
      <div className="toolbar" role="toolbar" aria-label={`Actions for ${g.name}`}>
        <Link className={`btn${!authed || !running ? ' disabled' : ''}`} to={consolePath(g.clusterId, g.type, g.node, g.vmid)}
          aria-disabled={!authed || !running} onClick={(e) => { if (!authed || !running) e.preventDefault(); }}
          title={!authed ? why : !running ? 'Start the guest to open its console' : undefined}>Console</Link>
        {!running && <button type="button" className="btn" disabled={!authed || g.template} title={why} onClick={() => plan('guest.start')}>Start</button>}
        {running && <button type="button" className="btn" disabled={!authed} title={why} onClick={() => plan('guest.shutdown')}>Shut down</button>}
        {running && <button type="button" className="btn" disabled={!authed} title={why} onClick={() => plan('guest.reboot')}>Reboot</button>}
        {running && <button type="button" className="btn" disabled={!authed} title={why} onClick={() => plan('guest.stop')}>Stop</button>}
        <button type="button" className="btn" disabled={!authed} title={why} aria-expanded={mode === 'migrate'} onClick={() => (mode === 'migrate' ? setMode(null) : void startMigrate())}>Migrate</button>
        <button type="button" className="btn" disabled={!authed} title={why} aria-expanded={mode === 'snapshot'} onClick={() => { setMode(mode === 'snapshot' ? null : 'snapshot'); setSnap(''); }}>Snapshot</button>
        <button type="button" className="btn btn-danger-outline" disabled={!authed} title={why} onClick={() => plan('guest.destroy')}>Destroy</button>
      </div>
      {mode === 'migrate' && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (target) plan('guest.migrate', { target, online: running }); }}>
          <label className="field"><span className="label">Move {g.name} from {g.node} to</span>
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={!targets?.length}>
              {targets === null && !err && <option>Loading nodes</option>}
              {targets?.length === 0 && <option value="">No other online node</option>}
              {targets?.map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </label>
          <button type="submit" className="btn btn-primary" disabled={!target}>Review migration</button>
          <button type="button" className="btn" onClick={() => setMode(null)}>Cancel</button>
          <span className="muted small" style={{ flexBasis: '100%' }}>{g.type === 'qemu' ? (running ? 'The VM keeps running while it moves.' : 'The VM is stopped, so it moves offline.') : 'Containers restart on the target node.'}</span>
          {err && <span className="tone-crit" role="alert">{err}</span>}
        </form>
      )}
      {mode === 'snapshot' && <SnapshotForm onSubmit={(name, description) => plan('guest.snapshot', { name, ...(description ? { description } : {}) })} onCancel={() => setMode(null)} value={snap} setValue={setSnap} />}
    </>
  );
}

function SnapshotForm({ onSubmit, onCancel, value, setValue }: { onSubmit: (n: string, d: string) => void; onCancel: () => void; value: string; setValue: (v: string) => void }) {
  const [desc, setDesc] = useState('');
  return (
    <form className="inline-form" onSubmit={(e) => { e.preventDefault(); onSubmit(value, desc); }}>
      <label className="field"><span className="label">Snapshot name</span>
        <input value={value} onChange={(e) => setValue(e.target.value)} pattern="[A-Za-z][A-Za-z0-9_\-]{1,39}" placeholder="pre-upgrade" required autoFocus
          title="Start with a letter; then letters, digits, - or _ (2 to 40 characters)" />
      </label>
      <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Description (optional)</span>
        <input value={desc} onChange={(e) => setDesc(e.target.value)} />
      </label>
      <button type="submit" className="btn btn-primary">Review snapshot</button>
      <button type="button" className="btn" onClick={onCancel}>Cancel</button>
    </form>
  );
}

export function GuestDetail() {
  const { cluster = '', vmid = '' } = useParams();
  const { guests, guestsError, clusterName, me } = useApp();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'summary') as TabId;
  const [tf, setTf] = useState<Timeframe>('hour');
  const g = guests?.find((x) => x.clusterId === cluster && String(x.vmid) === vmid) ?? null;
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;
  useCrumbs([{ label: 'Guests', to: '/guests' }, { label: clusterName(cluster), to: `/guests?cluster=${encodeURIComponent(cluster)}` }, { label: g?.name ?? vmid }]);

  const cfgPath = g ? `nodes/${g.node}/${g.type}/${g.vmid}/config` : null;
  const cfg = usePve<RawConfig>(authed && g ? cluster : null, cfgPath);

  if (!guests) {
    return <div className="page"><h1>Guest {vmid}</h1>{guestsError ? <ApiErrorView error={new Error(guestsError)} what="guests" /> : <div className="muted" role="status">Loading guest</div>}</div>;
  }
  if (!g) {
    return (
      <div className="page">
        <h1>Guest {vmid}</h1>
        <Empty title={`No guest ${vmid} on ${clusterName(cluster)}`}>It may have been destroyed or migrated to another cluster, or your PVE account cannot see it. <Link to="/guests">Back to all guests</Link></Empty>
      </div>
    );
  }

  const setTab = (t: TabId) => { const p = new URLSearchParams(params); p.set('tab', t); setParams(p, { replace: true }); };

  return (
    <div className="page">
      <div className="page-head">
        <h1>{g.name} <span className="title-id">{g.vmid}</span></h1>
        <GuestActionsWrapper g={g} />
        <div className="sub">
          <Status tone={guestTone(g.status)}>{g.status}</Status>{' '}
          {kindName(g)} on <Link to={nodePath(g.clusterId, g.node)}>{g.node}</Link>, {clusterName(g.clusterId)}
          {g.status === 'running' ? `, up ${uptime(g.uptime)}` : ''}
          {g.template ? ', template' : ''}
          {g.hastate ? <>, HA {g.hastate}</> : null}
          {g.tags.length > 0 && <> {g.tags.map((t) => <Link key={t} className="tag" to={`/guests?q=${encodeURIComponent(t)}`}>{t}</Link>)}</>}
        </div>
      </div>

      <Tabs tabs={TABS} value={tab} onChange={setTab} label="Guest views" idPrefix="guest" />
      <div role="tabpanel" id="guest-panel" aria-labelledby={`guest-tab-${tab}`} className="form-stack">
        {tab === 'summary' && <Summary g={g} tf={tf} setTf={setTf} cfg={cfg.data} />}
        {tab === 'hardware' && (cfg.error ? <ApiErrorView error={cfg.error} clusterId={cluster} onRetry={cfg.reload} what="the configuration" />
          : !authed ? <ApiErrorView error={loginNeeded()} clusterId={cluster} /> : <Hardware g={g} cfg={cfg.data} />)}
        {tab === 'options' && (cfg.error ? <ApiErrorView error={cfg.error} clusterId={cluster} onRetry={cfg.reload} what="the configuration" />
          : !authed ? <ApiErrorView error={loginNeeded()} clusterId={cluster} /> : <Options g={g} cfg={cfg.data} />)}
        {tab === 'snapshots' && <Snapshots g={g} />}
        {tab === 'tasks' && <TaskHistory g={g} />}
      </div>
    </div>
  );
}

function GuestActionsWrapper({ g }: { g: Guest }) {
  return <div className="form-stack" style={{ gap: 10, alignItems: 'flex-end' }}><GuestActions g={g} /></div>;
}

const loginNeeded = () => new ApiError(409, 'cluster_login_required', 'log in first');

function Summary({ g, tf, setTf, cfg }: { g: Guest; tf: Timeframe; setTf: (t: Timeframe) => void; cfg: RawConfig | null }) {
  const { clusterName } = useApp();
  const res = useMemo(() => [{ cluster: g.clusterId, kind: 'guest' as const, id: String(g.vmid), label: g.name }], [g.clusterId, g.vmid, g.name]);
  const hw = cfg ? parseGuestConfig(g.type, cfg) : null;
  const boot = hw?.disks.find((d) => d.media !== 'cdrom' && d.bus !== 'unused' && d.bus !== 'efidisk' && d.bus !== 'tpmstate');
  const running = g.status === 'running';
  return (
    <>
      <div className="facts">
        <div className="fact"><span className="k">CPU</span><span className="v num">{running ? `${formatPct(g.cpu)} of ${g.maxcpu} vCPU` : `${g.maxcpu} vCPU`}</span></div>
        <div className="fact"><span className="k">Memory</span><span className="v num">{running ? `${formatBytes(g.mem)} of ${formatBytes(g.maxmem)}` : formatBytes(g.maxmem)}</span></div>
        <div className="fact"><span className="k">{g.type === 'lxc' ? 'Root disk' : 'Boot disk'}</span><span className="v">{boot ? describeDisk(boot) : g.maxdisk ? formatBytes(g.maxdisk) : 'unknown'}</span></div>
        <div className="fact"><span className="k">Node</span><span className="v"><Link to={nodePath(g.clusterId, g.node)}>{g.node}</Link>, {clusterName(g.clusterId)}</span></div>
        <div className="fact"><span className="k">Uptime</span><span className="v">{uptime(g.uptime)}</span></div>
        <div className="fact"><span className="k">High availability</span><span className="v">{g.hastate ?? 'not managed'}</span></div>
      </div>
      <div className="ov-bar"><h2 style={{ marginRight: 'auto' }}>History</h2><TimeRange value={tf} onChange={setTf} /></div>
      <div className="grid-2">
        <div className="panel panel-body"><MetricChart title="CPU" resources={res} metrics={['cpu']} timeframe={tf} /></div>
        <div className="panel panel-body"><MetricChart title="Memory used" resources={res} metrics={['memUsed']} timeframe={tf} /></div>
        <div className="panel panel-body"><MetricChart title="Network" resources={res} metrics={['netIn', 'netOut']} timeframe={tf} /></div>
        <div className="panel panel-body"><MetricChart title="Disk I/O" resources={res} metrics={['diskRead', 'diskWrite']} timeframe={tf} /></div>
      </div>
    </>
  );
}

type HwRow = { k: string; v: React.ReactNode; n?: string; keys: string[] };

function Hardware({ g, cfg }: { g: Guest; cfg: RawConfig | null }) {
  const { fleet, me } = useApp();
  const [editing, setEditing] = useState<{ id: string; keys?: string[]; addFamily?: string; heading: string } | null>(null);
  if (!cfg) return <div className="panel"><div className="muted panel-body" role="status">Loading the configuration</div></div>;
  const authed = !!me.clusters.find((c) => c.id === g.clusterId)?.authed;
  const hw = parseGuestConfig(g.type, cfg);
  const rows: HwRow[] = [];
  const cpu = `${hw.cores} core${hw.cores === 1 ? '' : 's'}${g.type === 'qemu' ? `, ${hw.sockets} socket${hw.sockets === 1 ? '' : 's'}, type ${hw.cpuType}` : ''}`;
  rows.push({ k: 'Processors', v: cpu, n: hw.vcpus ? `${hw.vcpus} vCPUs hot-plugged` : hw.cpulimit ? `limit ${hw.cpulimit}` : undefined, keys: g.type === 'qemu' ? ['cores', 'sockets', 'cpu'] : ['cores', 'cpulimit'] });
  rows.push({ k: 'Memory', v: `${formatBytes(hw.memory)}${hw.balloon === 'off' ? ', ballooning off' : hw.balloon ? `, balloon minimum ${formatBytes(hw.balloon)}` : ''}`, keys: g.type === 'qemu' ? ['memory', 'balloon'] : ['memory'] });
  if (g.type === 'lxc') rows.push({ k: 'Swap', v: formatBytes(hw.swap ?? 0), keys: ['swap'] });
  if (g.type === 'qemu') {
    rows.push({ k: 'Machine', v: `${hw.machine ?? 'i440fx (default)'}, ${hw.bios === 'ovmf' ? 'OVMF (UEFI)' : 'SeaBIOS'}`, keys: ['machine', 'bios'] });
    if (hw.scsihw) rows.push({ k: 'SCSI controller', v: hw.scsihw, keys: ['scsihw'] });
  }
  for (const d of hw.disks) {
    const storage = d.storage && d.media !== 'cdrom'
      ? <><Link to={storagePath(g.clusterId, d.storage, g.node, !!fleet?.clusters.find((c) => c.id === g.clusterId)?.storage.find((s) => s.id === d.storage)?.shared)}>{d.storage}</Link>{describeDisk(d).slice(d.storage.length)}</>
      : describeDisk(d);
    rows.push({ k: d.bus === 'rootfs' ? 'Root disk' : d.bus === 'unused' ? `Unused disk ${d.key.slice(6)}` : d.bus === 'efidisk' ? 'EFI disk' : d.bus === 'tpmstate' ? 'TPM state' : `Disk ${d.key}`, v: storage, n: d.volume && d.media !== 'cdrom' ? d.volume : undefined, keys: [d.key] });
  }
  for (const n of hw.nets) rows.push({ k: `Network ${n.key}`, v: describeNic(n) || 'no details', n: n.mac, keys: [n.key] });
  for (const p of hw.hostpci) rows.push({ k: `PCI ${p.key}`, v: describePci(p), keys: [p.key] });
  const cfgPath = `/nodes/${g.node}/${g.type}/${g.vmid}/config`;
  const adds = g.type === 'qemu'
    ? [{ f: 'net', label: 'Network device' }, { f: 'scsi', label: 'Disk' }, { f: 'hostpci', label: 'PCI device or GPU' }]
    : [{ f: 'net', label: 'Network device' }, { f: 'mp', label: 'Mount point' }, { f: 'dev', label: 'Device' }];
  const why = authed ? undefined : 'Log in to this cluster first';
  return (
    <section className="panel" aria-labelledby="hw-h">
      <div className="panel-head">
        <h2 id="hw-h">Hardware</h2>
        <span className="muted">Changes open in Changes for review.{g.status === 'running' && g.type === 'qemu' ? ' Some apply only after the VM restarts.' : ''}</span>
        <AddDeviceMenu adds={adds} disabled={!authed} title={why} onPick={(f, label) => setEditing({ id: `add-${f}`, addFamily: f, keys: [], heading: `Add ${label.toLowerCase()}` })} />
      </div>
      {editing?.id.startsWith('add-') && (
        <div className="panel-body editor-wrap">
          <ResourceEditor clusterId={g.clusterId} path={cfgPath} method="PUT" keys={editing.keys} addFamily={editing.addFamily} heading={editing.heading}
            title={`${editing.heading} on ${g.name} (${g.vmid})`} onCancel={() => setEditing(null)} onSubmitted={() => setEditing(null)} />
        </div>
      )}
      {rows.map((r) => (
        <Fragment key={r.k}>
          <div className="hw-row">
            <span className="k">{r.k}</span><span className="v">{r.v}</span>{r.n && <span className="n mono">{r.n}</span>}
            <button type="button" className="link-btn small hw-edit" disabled={!authed} title={why} aria-expanded={editing?.id === r.k}
              aria-label={`Edit ${r.k}`} onClick={() => setEditing(editing?.id === r.k ? null : { id: r.k, keys: r.keys, heading: `Edit ${r.k.toLowerCase()}` })}>Edit</button>
          </div>
          {editing?.id === r.k && (
            <div className="panel-body editor-wrap">
              <ResourceEditor clusterId={g.clusterId} path={cfgPath} method="PUT" keys={r.keys} heading={editing.heading}
                title={`Change ${r.k.toLowerCase()} of ${g.name} (${g.vmid})`} onCancel={() => setEditing(null)} onSubmitted={() => setEditing(null)} />
            </div>
          )}
        </Fragment>
      ))}
    </section>
  );
}

function AddDeviceMenu({ adds, disabled, title, onPick }: { adds: { f: string; label: string }[]; disabled: boolean; title?: string; onPick: (f: string, label: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="user-menu">
      <button type="button" className="btn btn-sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled} title={title} onClick={() => setOpen((v) => !v)}>Add device</button>
      {open && (
        <div className="menu" role="menu" aria-label="Add device" onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}>
          {adds.map((a) => <button key={a.f} type="button" role="menuitem" onClick={() => { setOpen(false); onPick(a.f, a.label); }}>{a.label}</button>)}
        </div>
      )}
    </div>
  );
}

function Options({ g, cfg }: { g: Guest; cfg: RawConfig | null }) {
  const { me } = useApp();
  const [editing, setEditing] = useState(false);
  if (!cfg) return <div className="panel"><div className="muted panel-body" role="status">Loading the configuration</div></div>;
  const authed = !!me.clusters.find((c) => c.id === g.clusterId)?.authed;
  const hw = parseGuestConfig(g.type, cfg);
  return (
    <section className="panel" aria-labelledby="opt-h">
      <div className="panel-head">
        <h2 id="opt-h">Options</h2><span className="muted">Every other key in the {g.type === 'qemu' ? 'VM' : 'container'} configuration</span>
        <button type="button" className="btn btn-sm" disabled={!authed} aria-expanded={editing} onClick={() => setEditing((v) => !v)}>{editing ? 'Close editor' : 'Edit options'}</button>
      </div>
      {editing && (
        <div className="panel-body editor-wrap">
          <ResourceEditor clusterId={g.clusterId} path={`/nodes/${g.node}/${g.type}/${g.vmid}/config`} method="PUT"
            keys={hw.options.map(([k]) => k).filter((k) => !/^(vmgenid|smbios1|meta)$/.test(k))}
            title={`Change options of ${g.name} (${g.vmid})`} onCancel={() => setEditing(false)} onSubmitted={() => setEditing(false)} />
        </div>
      )}
      {hw.options.length === 0 ? <Empty title="No other options set" /> : (
        <dl className="kv">
          {hw.options.map(([k, v]) => <Fragment key={k}><dt className="mono">{k}</dt><dd className="mono">{v}</dd></Fragment>)}
        </dl>
      )}
    </section>
  );
}

interface Snap { name: string; description?: string; snaptime?: number; parent?: string; vmstate?: number; running?: number }

function Snapshots({ g }: { g: Guest }) {
  const { openPlan, me, lastAudit } = useApp();
  const authed = !!me.clusters.find((c) => c.id === g.clusterId)?.authed;
  const { data, error, reload } = usePve<Snap[]>(g.clusterId, `nodes/${g.node}/${g.type}/${g.vmid}/snapshot`, {}, lastAudit?.status === 'running' ? '' : lastAudit?.id ?? '');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const ordered = useMemo(() => {
    if (!data) return [];
    const kids = new Map<string, Snap[]>();
    for (const s of data) { const p = s.parent ?? ''; kids.set(p, [...(kids.get(p) ?? []), s]); }
    const out: { s: Snap; depth: number }[] = [];
    const walk = (p: string, depth: number) => {
      for (const s of (kids.get(p) ?? []).sort((a, b) => (a.snaptime ?? Infinity) - (b.snaptime ?? Infinity))) { out.push({ s, depth }); walk(s.name, depth + 1); }
    };
    walk('', 0);
    return out;
  }, [data]);
  return (
    <section className="panel" aria-labelledby="snap-h">
      <div className="panel-head">
        <h2 id="snap-h">Snapshots</h2>
        <button type="button" className="btn btn-sm" disabled={!authed} onClick={() => setAdding((v) => !v)} aria-expanded={adding}>Take snapshot</button>
      </div>
      {adding && <div className="panel-body"><SnapshotForm value={name} setValue={setName} onCancel={() => setAdding(false)}
        onSubmit={(n, d) => { setAdding(false); void openPlan({ action: 'guest.snapshot', clusterId: g.clusterId, params: { targets: [{ vmid: g.vmid, node: g.node, type: g.type }], name: n, ...(d ? { description: d } : {}) } }); }} /></div>}
      {error ? <div className="panel-body"><ApiErrorView error={error} clusterId={g.clusterId} onRetry={reload} what="snapshots" /></div>
        : !data ? <div className="muted panel-body" role="status">Loading snapshots</div>
          : ordered.length <= 1 ? <Empty title="No snapshots">Take one before risky changes; it is listed here with its parent.</Empty> : (
            <ul className="snap-tree">
              {ordered.map(({ s, depth }) => (
                <li key={s.name}>
                  <span className="branch" aria-hidden="true">{depth ? `${'  '.repeat(depth - 1)}└ ` : ''}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    {s.name === 'current' ? <strong>Now (current state)</strong> : <strong>{s.name}</strong>}
                    {s.name !== 'current' && s.description && <div className="ws">{s.description.trim()}</div>}
                  </span>
                  {s.vmstate ? <Badge kind="neutral">Includes RAM</Badge> : null}
                  <span className="ws nowrap">{s.snaptime ? clock(s.snaptime) : ''}</span>
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}

interface PveTask { upid: string; type: string; starttime: number; endtime?: number; status?: string; user: string; node: string }

export function taskBadge(status?: string, endtime?: number) {
  if (!endtime && !status) return <Badge kind="info">Running</Badge>;
  if (status === 'OK') return <Badge kind="ok">OK</Badge>;
  if (/^WARNINGS/.test(status ?? '')) return <Badge kind="warn">Warnings</Badge>;
  return <Badge kind="crit">Failed</Badge>;
}

const duration = (a: number, b?: number) => {
  if (!b) return 'running';
  const s = Math.max(0, b - a);
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};

function TaskHistory({ g }: { g: Guest }) {
  const { lastAudit } = useApp();
  const { data, error, reload } = usePve<PveTask[]>(g.clusterId, `nodes/${g.node}/tasks`, { vmid: g.vmid, limit: 50 }, lastAudit?.id ?? '');
  return (
    <section className="panel" aria-labelledby="task-h">
      <div className="panel-head"><h2 id="task-h">Task history</h2><span className="muted">Tasks for {g.vmid} on {g.node}, newest first. Tasks on earlier nodes stay in their logs.</span></div>
      {error ? <div className="panel-body"><ApiErrorView error={error} clusterId={g.clusterId} onRetry={reload} what="the task log" /></div>
        : !data ? <div className="muted panel-body" role="status">Loading tasks</div>
          : data.length === 0 ? <Empty title="No tasks recorded for this guest on this node" /> : (
            <div className="table-wrap">
              <table className="table dense">
                <thead><tr><th scope="col">Started</th><th scope="col">Task</th><th scope="col">Duration</th><th scope="col">User</th><th scope="col">Result</th></tr></thead>
                <tbody>
                  {data.map((t) => (
                    <tr key={t.upid}>
                      <td className="nowrap">{clock(t.starttime)}</td>
                      <td className="mono">{t.type}</td>
                      <td className="num">{duration(t.starttime, t.endtime)}</td>
                      <td className="text-2">{t.user}</td>
                      <td>{taskBadge(t.status, t.endtime)}{t.status && t.status !== 'OK' ? <div className="ws" style={{ marginTop: 4 }}>{t.status}</div> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
    </section>
  );
}

