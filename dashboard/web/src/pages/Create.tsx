import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/http';
import { useApp, useCrumbs } from '../state/app';
import { usePve } from '../lib/hooks';
import { formatBytes } from '../lib/units';
import {
  callsCli, ctCalls, ctGpuDevices, ctProblems, defaultCt, defaultVm, gpuNodes, llmPreset, pinsGpu, vmCalls, vmProblems, withGpu,
  type ApiCall, type CtSpec, type GpuChoice, type VmSpec,
} from '../lib/wizard';
import { mappingNodes, type HaRule } from '../lib/ha';
import { deviceName, groupPeers, isDisplay, isGpu, mapEntries, mappingFor, mappingsOnNode, type PciDevice, type PciMapping } from '../lib/pci';
import { ApiErrorView } from '../components/ClusterLogin';
import { ClusterPicker, useClusterParam } from '../components/ClusterPicker';
import { Badge, CopyButton, Empty } from '../components/ui';
import { Tabs } from './GuestDetail';
import { HelpLink } from '../components/HelpLink';

const KINDS = [{ id: 'vm', label: 'Virtual machine' }, { id: 'ct', label: 'Container' }] as const;
type Kind = (typeof KINDS)[number]['id'];

interface StorageRow { storage: string; type: string; content: string; shared?: number; avail?: number; total?: number; active?: number }
interface ContentRow { volid: string; content: string; size?: number }
interface Bridge { iface: string; type: string; comments?: string; cidr?: string; bridge_vlan_aware?: number }
interface Vnet { vnet: string; zone?: string; alias?: string; tag?: number }

const OS_TYPES: { v: string; label: string }[] = [
  { v: 'l26', label: 'Linux (kernel 2.6 or newer)' }, { v: 'win11', label: 'Windows 11 or Server 2022/2025' }, { v: 'win10', label: 'Windows 10 or Server 2016/2019' },
  { v: 'other', label: 'Other' },
];
const CPU_TYPES = ['host', 'x86-64-v2-AES', 'x86-64-v3', 'x86-64-v4', 'kvm64'];

export function Create() {
  useCrumbs([{ label: 'Create' }]);
  const { me, fleet, clusterName } = useApp();
  const [params, setParams] = useSearchParams();
  const kind = (params.get('kind') === 'ct' ? 'ct' : 'vm') as Kind;
  const [cluster, setCluster] = useClusterParam();
  const authed = !!me.clusters.find((c) => c.id === cluster)?.authed;
  const nodes = fleet?.clusters.find((c) => c.id === cluster)?.nodes.filter((n) => n.online) ?? [];
  const setKind = (k: Kind) => { const p = new URLSearchParams(params); p.set('kind', k); setParams(p, { replace: true }); };
  return (
    <div className="page">
      <div className="page-head">
        <h1>Create</h1><HelpLink />
        <ClusterPicker value={cluster} onChange={setCluster} />
        <div className="sub">Builds the exact PVE API calls and opens them in Changes. Nothing is created until you apply it.</div>
      </div>
      <Tabs tabs={KINDS} value={kind} onChange={setKind} label="What to create" idPrefix="create" />
      <div role="tabpanel" id="create-panel" aria-labelledby={`create-tab-${kind}`}>
        {!authed ? <ApiErrorView error={new ApiError(409, 'cluster_login_required', '')} clusterId={cluster} />
          : !fleet ? <div className="muted" role="status">Loading nodes</div>
            : !nodes.length ? (
              <Empty title={`No online node of ${clusterName(cluster)} is visible to you`}>
                galley builds a create request for a node your PVE account can see. Ask a PVE administrator for access to the nodes
                (Sys.Audit on /nodes), or pick another cluster.
              </Empty>
            )
            : kind === 'vm' ? <VmWizard key={`vm-${cluster}`} cluster={cluster} nodes={nodes.map((n) => n.name)} />
              : <CtWizard key={`ct-${cluster}`} cluster={cluster} nodes={nodes.map((n) => n.name)} />}
      </div>
    </div>
  );
}

// ---------- shared data hooks ----------

function useNextId(cluster: string, vmid: string, set: (v: string) => void) {
  const next = usePve<number | string>(cluster, 'cluster/nextid');
  useEffect(() => { if (next.data !== null && !vmid) set(String(next.data)); }, [next.data, vmid, set]);
  return next;
}

function useStorages(cluster: string, node: string, content: string) {
  return usePve<StorageRow[]>(node ? cluster : null, `nodes/${node}/storage`, { content });
}

/** Volumes of one content type across every storage of a node that holds it (ISO images, templates). */
function useVolumes(cluster: string, node: string, content: 'iso' | 'vztmpl' | 'import') {
  const { api } = useApp();
  const stores = useStorages(cluster, node, content);
  const [vols, setVols] = useState<ContentRow[] | null>(null);
  const key = (stores.data ?? []).map((s) => s.storage).join(',');
  useEffect(() => {
    if (!stores.data) return;
    let alive = true;
    Promise.all(stores.data.filter((s) => s.active !== 0).map((s) => api.pve<ContentRow[]>(cluster, `nodes/${node}/storage/${s.storage}/content`, { content }).catch(() => [] as ContentRow[])))
      .then((r) => { if (alive) setVols(r.flat().filter((x) => x.content === content)); });
    return () => { alive = false; };
  }, [api, cluster, node, content, key, stores.data]);
  return { vols, error: stores.error };
}

function useNetworks(cluster: string, node: string) {
  const bridges = usePve<Bridge[]>(node ? cluster : null, `nodes/${node}/network`, { type: 'any_bridge' });
  const vnets = usePve<Vnet[]>(cluster, 'cluster/sdn/vnets');
  return { bridges: bridges.data, vnets: vnets.error ? [] : vnets.data, error: bridges.error };
}

const free = (s: StorageRow) => (s.avail !== undefined ? `, ${formatBytes(s.avail)} free` : '');

function NetworkSelect({ id, value, onChange, bridges, vnets }: { id: string; value: string; onChange: (v: string) => void; bridges: Bridge[] | null; vnets: Vnet[] | null }) {
  return (
    <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {!bridges && <option value={value}>{value || 'Loading bridges'}</option>}
      {bridges && <optgroup label="Bridges on this node">{bridges.filter((b) => b.type !== 'vnet').map((b) => <option key={b.iface} value={b.iface}>{b.iface}{b.comments ? `, ${b.comments}` : b.cidr ? `, ${b.cidr}` : ''}{b.bridge_vlan_aware ? ', VLAN aware' : ''}</option>)}</optgroup>}
      {vnets && vnets.length > 0 && <optgroup label="SDN VNets">{vnets.map((v) => <option key={v.vnet} value={v.vnet}>{v.vnet}{v.alias ? `, ${v.alias}` : ''}{v.tag ? `, tag ${v.tag}` : ''}</option>)}</optgroup>}
    </select>
  );
}

function Steps<T extends string>({ steps, value, onChange }: { steps: readonly { id: T; label: string }[]; value: T; onChange: (s: T) => void }) {
  return (
    <ol className="wizard-steps" aria-label="Steps">
      {steps.map((s, i) => (
        <li key={s.id}>
          <button type="button" aria-current={s.id === value ? 'step' : undefined} className={s.id === value ? 'cur' : ''} onClick={() => onChange(s.id)}>
            <span className="n">{i + 1}</span>{s.label}
          </button>
        </li>
      ))}
    </ol>
  );
}

function Preview({ calls, problems, onReview, notes, what }: { calls: ApiCall[]; problems: string[]; onReview: () => void; notes?: React.ReactNode; what: string }) {
  const cli = callsCli(calls);
  return (
    <aside className="panel wizard-preview" aria-label="Preview">
      <div className="panel-head"><h2>Preview</h2><span className="muted">{calls.length} API call{calls.length === 1 ? '' : 's'}</span></div>
      <div className="panel-body form-stack">
        <pre className="cli" aria-label="Commands this change runs">{cli}</pre>
        <details>
          <summary className="small">Request body (JSON)</summary>
          <pre className="cli json-out" style={{ marginTop: 8 }}>{JSON.stringify(calls, null, 2)}</pre>
        </details>
        <div><CopyButton text={cli} /></div>
        {notes}
        {problems.length > 0 && (
          <ul className="problems" aria-label="Before you can review">
            {problems.map((p) => <li key={p}>{p}</li>)}
          </ul>
        )}
        <button type="button" className="btn btn-primary btn-lg" disabled={problems.length > 0} onClick={onReview}>Review change</button>
        <p className="explain">Opens in Changes as {what}. You apply it there; it runs as you.</p>
      </div>
    </aside>
  );
}

const numIn = (v: string) => (v === '' ? 0 : Number(v));

// ---------- VM ----------

const VM_STEPS = [
  { id: 'general', label: 'General' }, { id: 'os', label: 'OS and media' }, { id: 'system', label: 'System' }, { id: 'disk', label: 'Disk' },
  { id: 'cpu', label: 'CPU and memory' }, { id: 'network', label: 'Network' }, { id: 'gpu', label: 'GPU' },
] as const;
type VmStep = (typeof VM_STEPS)[number]['id'];

function VmWizard({ cluster, nodes }: { cluster: string; nodes: string[] }) {
  const { openPlan } = useApp();
  const [s, setS] = useState<VmSpec>(() => defaultVm(nodes[0]));
  const [step, setStep] = useState<VmStep>('general');
  const [media, setMedia] = useState<'iso' | 'cloud' | 'none'>('iso');
  const set = (p: Partial<VmSpec>) => setS((x) => ({ ...x, ...p }));
  const setVmid = useMemo(() => (v: string) => setS((x) => ({ ...x, vmid: v })), []);
  useNextId(cluster, s.vmid, setVmid);
  const images = useStorages(cluster, s.node, 'images');
  const isos = useVolumes(cluster, s.node, 'iso');
  const imports = useVolumes(cluster, s.node, 'import');
  const net = useNetworks(cluster, s.node);
  const mappings = usePve<PciMapping[]>(cluster, 'cluster/mapping/pci');
  const pci = usePve<PciDevice[]>(s.node ? cluster : null, `nodes/${s.node}/hardware/pci`);
  // only read when pinning: rule ids already in use (reading needs Sys.Audit on /)
  const haRules = usePve<HaRule[]>(pinsGpu(s) ? cluster : null, 'cluster/ha/rules');

  // default the storage to the first one that can hold disks
  useEffect(() => {
    const first = images.data?.[0]?.storage;
    if (first && !images.data!.some((x) => x.storage === s.disk.storage)) setS((x) => ({ ...x, disk: { ...x.disk, storage: first }, efiStorage: '', cloudInit: { ...x.cloudInit, storage: '' } }));
  }, [images.data, s.disk.storage]);

  const spec: VmSpec = { ...s, iso: media === 'iso' ? s.iso : '', cloudInit: { ...s.cloudInit, enabled: media === 'cloud' }, disk: { ...s.disk, importFrom: media === 'cloud' ? s.disk.importFrom : '' } };
  const calls = vmCalls(spec, (haRules.data ?? []).map((r) => r.rule));
  const pin = pinsGpu(s);
  const problems = vmProblems(spec);
  const idx = VM_STEPS.findIndex((x) => x.id === step);
  const nodeMappings = mappingsOnNode(mappings.data ?? [], s.node);

  const gpuNotes = s.gpu && (
    <div className="notice notice-info small">
      <div className="grow">
        <strong>{s.gpu.label ?? s.gpu.mapping ?? s.gpu.host}</strong> is attached as hostpci0. The VM uses q35 and OVMF with ballooning off.
        {!s.gpu.mapping
          ? <> A raw device ties the VM to {s.node}: HA and migration cannot move it. Create a PCI mapping on the Hardware page to fix that.</>
          : pin
            ? <> HA keeps it on {gpuNodes(s).join(', ')}{s.start ? ' and starts it once it is created' : ''}.</>
            : <> If you put it under HA later, add a node-affinity rule for {gpuNodes(s).join(', ')} so HA never moves it to a node without the card.</>}
      </div>
    </div>
  );

  const review = () => void openPlan({
    action: 'api.call', clusterId: cluster,
    params: {
      title: `Create VM ${s.vmid}${s.name ? ` (${s.name})` : ''} on ${s.node}`,
      summary: `${s.cores} cores, ${formatBytes(s.memoryMiB * 1024 ** 2)} memory, ${spec.disk.importFrom ? 'disk imported from an image' : `${s.disk.sizeGiB} GiB disk`} on ${s.disk.storage}${s.gpu ? `, GPU ${s.gpu.mapping ?? s.gpu.host}` : ''}.${pin ? ` HA keeps it on ${gpuNodes(s).join(', ')}.` : ''}${s.start ? ' Starts when created.' : ''}`,
      calls,
    },
  });

  return (
    <div className="wizard">
      <div className="wizard-main">
        <Steps steps={VM_STEPS} value={step} onChange={setStep} />
        <section className="panel" aria-label={VM_STEPS[idx].label}>
          <div className="panel-head"><h2>{VM_STEPS[idx].label}</h2>
            {step === 'general' && <button type="button" className="btn btn-sm" onClick={() => {
              const m = nodeMappings[0];
              setS((x) => llmPreset(x, m ? { mapping: m.id, label: m.id, nodes: mappingNodes(m) } : null)); setMedia('cloud');
            }}>Use the LLM server preset</button>}
          </div>
          <div className="panel-body form-stack">
            {step === 'general' && <>
              <div className="form-row">
                <label className="field"><span className="label">Node</span>
                  <select value={s.node} onChange={(e) => set({ node: e.target.value, gpu: null })}>{nodes.map((n) => <option key={n}>{n}</option>)}</select></label>
                <label className="field"><span className="label">VMID</span>
                  <input value={s.vmid} onChange={(e) => set({ vmid: e.target.value.trim() })} inputMode="numeric" /></label>
                <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Name</span>
                  <input value={s.name} onChange={(e) => set({ name: e.target.value.trim() })} placeholder="web03" spellCheck={false} /></label>
              </div>
              <label className="field"><span className="label">Tags (optional)</span><input value={s.tags} onChange={(e) => set({ tags: e.target.value })} placeholder="prod, web" /></label>
              <div className="row-actions">
                <label className="check"><input type="checkbox" checked={s.start} onChange={(e) => set({ start: e.target.checked })} />Start after it is created</label>
                <label className="check"><input type="checkbox" checked={s.onboot} onChange={(e) => set({ onboot: e.target.checked })} />Start when {s.node} boots</label>
              </div>
              <p className="explain">The LLM server preset picks a GPU on {s.node} (if one is mapped), 16 cores, 64 GiB memory and a 200 GiB disk, set up for a Debian or Ubuntu cloud image.</p>
            </>}

            {step === 'os' && <>
              <label className="field"><span className="label">Guest OS</span>
                <select value={s.ostype} onChange={(e) => set({ ostype: e.target.value })}>{OS_TYPES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</select></label>
              <fieldset className="field fieldset"><legend className="label">Boot media</legend>
                <div className="row-actions">
                  {([['iso', 'Install from an ISO'], ['cloud', 'Cloud image with cloud-init'], ['none', 'No media']] as const).map(([v, l]) => (
                    <label key={v} className="check"><input type="radio" name="media" checked={media === v} onChange={() => setMedia(v)} />{l}</label>))}
                </div>
              </fieldset>
              {media === 'iso' && (
                <label className="field"><span className="label">ISO image</span>
                  <select value={s.iso} onChange={(e) => set({ iso: e.target.value })}>
                    <option value="">{isos.vols === null ? 'Loading ISO images' : isos.vols.length ? 'Choose an ISO' : `No ISO images on ${s.node}`}</option>
                    {isos.vols?.map((v) => <option key={v.volid} value={v.volid}>{v.volid}{v.size ? `, ${formatBytes(v.size)}` : ''}</option>)}
                  </select></label>
              )}
              {media === 'cloud' && <>
                <label className="field"><span className="label">Boot disk image (optional)</span>
                  <select value={s.disk.importFrom} onChange={(e) => set({ disk: { ...s.disk, importFrom: e.target.value } })}>
                    <option value="">Empty disk: I will import an image later</option>
                    {imports.vols?.map((v) => <option key={v.volid} value={v.volid}>{v.volid}</option>)}
                  </select>
                  <span className="hint">Debian 13 (debian-13-genericcloud-amd64.qcow2) or Ubuntu 24.04 (noble-server-cloudimg-amd64.img) work well. Upload one to a storage with the Import content type, or run <code>qm disk import {s.vmid || '<vmid>'} &lt;image&gt; {s.disk.storage || '<storage>'}</code> afterwards.</span>
                </label>
                <div className="form-row">
                  <label className="field"><span className="label">Cloud-init user</span><input value={s.cloudInit.user} onChange={(e) => set({ cloudInit: { ...s.cloudInit, user: e.target.value.trim() } })} placeholder="debian" /></label>
                  <label className="field"><span className="label">Address</span>
                    <select value={s.cloudInit.ip} onChange={(e) => set({ cloudInit: { ...s.cloudInit, ip: e.target.value as 'dhcp' | 'static' } })}><option value="dhcp">DHCP</option><option value="static">Static</option></select></label>
                  {s.cloudInit.ip === 'static' && <>
                    <label className="field"><span className="label">Address/prefix</span><input value={s.cloudInit.cidr} onChange={(e) => set({ cloudInit: { ...s.cloudInit, cidr: e.target.value.trim() } })} placeholder="192.0.2.50/24" /></label>
                    <label className="field"><span className="label">Gateway</span><input value={s.cloudInit.gateway} onChange={(e) => set({ cloudInit: { ...s.cloudInit, gateway: e.target.value.trim() } })} placeholder="192.0.2.1" /></label>
                  </>}
                </div>
                <label className="field"><span className="label">SSH public keys</span>
                  <textarea rows={3} value={s.cloudInit.sshKeys} onChange={(e) => set({ cloudInit: { ...s.cloudInit, sshKeys: e.target.value } })} placeholder="ssh-ed25519 AAAA… you@laptop" />
                  <span className="hint">One OpenSSH public key per line. galley does not set passwords.</span></label>
              </>}
            </>}

            {step === 'system' && <>
              <div className="form-row">
                <label className="field"><span className="label">Machine</span>
                  <select value={s.machine} onChange={(e) => set({ machine: e.target.value as VmSpec['machine'] })} disabled={!!s.gpu}><option value="q35">q35 (PCIe, recommended)</option><option value="pc">i440fx (legacy)</option></select></label>
                <label className="field"><span className="label">Firmware</span>
                  <select value={s.bios} onChange={(e) => set({ bios: e.target.value as VmSpec['bios'] })} disabled={!!s.gpu}><option value="ovmf">OVMF (UEFI)</option><option value="seabios">SeaBIOS (legacy BIOS)</option></select></label>
                {s.bios === 'ovmf' && (
                  <label className="field"><span className="label">EFI disk storage</span>
                    <select value={s.efiStorage} onChange={(e) => set({ efiStorage: e.target.value })}>
                      <option value="">Same as the boot disk{s.disk.storage ? ` (${s.disk.storage})` : ''}</option>
                      {images.data?.map((x) => <option key={x.storage} value={x.storage}>{x.storage}</option>)}
                    </select></label>
                )}
              </div>
              {s.gpu && <p className="explain">A GPU is attached, so machine and firmware stay at q35 and OVMF.</p>}
              <p className="explain">SCSI controller: VirtIO SCSI single (one I/O thread per disk). The QEMU guest agent is enabled.</p>
            </>}

            {step === 'disk' && <>
              {images.error ? <ApiErrorView error={images.error} clusterId={cluster} onRetry={images.reload} what="storages" /> : null}
              <div className="form-row">
                <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Storage</span>
                  <select value={s.disk.storage} onChange={(e) => set({ disk: { ...s.disk, storage: e.target.value } })}>
                    {!images.data && <option value="">Loading storages</option>}
                    {images.data?.map((x) => <option key={x.storage} value={x.storage}>{x.storage}, {x.type}{x.shared ? ', shared' : ''}{free(x)}</option>)}
                  </select></label>
                <label className="field"><span className="label">Size (GiB)</span>
                  <input type="number" min={1} value={s.disk.sizeGiB} disabled={!!spec.disk.importFrom} onChange={(e) => set({ disk: { ...s.disk, sizeGiB: numIn(e.target.value) } })} /></label>
              </div>
              {spec.disk.importFrom && <p className="explain">The disk is copied from {spec.disk.importFrom}; grow it after creation if you need more space.</p>}
              <div className="row-actions">
                <span className="muted small">Bus scsi0, VirtIO SCSI single.</span>
                <label className="check"><input type="checkbox" checked={s.disk.iothread} onChange={(e) => set({ disk: { ...s.disk, iothread: e.target.checked } })} />I/O thread</label>
                <label className="check"><input type="checkbox" checked={s.disk.discard} onChange={(e) => set({ disk: { ...s.disk, discard: e.target.checked } })} />Discard (TRIM)</label>
                <label className="check"><input type="checkbox" checked={s.disk.ssd} onChange={(e) => set({ disk: { ...s.disk, ssd: e.target.checked } })} />Show as SSD</label>
              </div>
            </>}

            {step === 'cpu' && <>
              <div className="form-row">
                <label className="field"><span className="label">Cores</span><input type="number" min={1} value={s.cores} onChange={(e) => set({ cores: numIn(e.target.value) })} /></label>
                <label className="field"><span className="label">Sockets</span><input type="number" min={1} max={4} value={s.sockets} onChange={(e) => set({ sockets: numIn(e.target.value) })} /></label>
                <label className="field"><span className="label">CPU type</span>
                  <select value={s.cpuType} onChange={(e) => set({ cpuType: e.target.value })}>{CPU_TYPES.map((c) => <option key={c}>{c}</option>)}</select></label>
              </div>
              <p className="explain">host passes the node&apos;s CPU through: fastest, but live migration needs identical CPUs on every node. x86-64-v2-AES migrates anywhere.</p>
              <div className="form-row">
                <label className="field"><span className="label">Memory (MiB)</span><input type="number" min={16} step={1024} value={s.memoryMiB} onChange={(e) => set({ memoryMiB: numIn(e.target.value) })} /></label>
                <label className="field"><span className="label">Balloon minimum (MiB)</span>
                  <input type="number" min={0} value={s.balloonMiB ?? ''} placeholder="PVE default" disabled={!!s.gpu} onChange={(e) => set({ balloonMiB: e.target.value === '' ? null : numIn(e.target.value) })} /></label>
              </div>
              <p className="explain">{s.gpu ? 'Ballooning is off: a passed-through GPU pins all guest memory.' : '0 turns ballooning off. Empty leaves PVE\'s default (balloon down to the memory size).'} {formatBytes(s.memoryMiB * 1024 ** 2)} in total.</p>
            </>}

            {step === 'network' && <>
              {net.error ? <ApiErrorView error={net.error} clusterId={cluster} what="bridges" /> : null}
              <div className="form-row">
                <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Bridge or VNet</span>
                  <NetworkSelect id="vm-br" value={s.net.bridge} onChange={(v) => set({ net: { ...s.net, bridge: v } })} bridges={net.bridges} vnets={net.vnets} /></label>
                <label className="field"><span className="label">Model</span>
                  <select value={s.net.model} onChange={(e) => set({ net: { ...s.net, model: e.target.value } })}><option value="virtio">VirtIO (paravirtualized)</option><option value="e1000e">Intel E1000E</option><option value="vmxnet3">VMware vmxnet3</option></select></label>
                <label className="field"><span className="label">VLAN tag (optional)</span><input value={s.net.vlan} onChange={(e) => set({ net: { ...s.net, vlan: e.target.value.trim() } })} inputMode="numeric" placeholder="none" /></label>
              </div>
              <label className="check"><input type="checkbox" checked={s.net.firewall} onChange={(e) => set({ net: { ...s.net, firewall: e.target.checked } })} />PVE firewall on this interface</label>
            </>}

            {step === 'gpu' && <GpuStep node={s.node} gpu={s.gpu} mappings={mappings.data} mapErr={mappings.error} pci={pci.data} pciErr={pci.error}
              onPick={(g) => setS((x) => withGpu(x, g))} onPreset={(g) => { setS((x) => llmPreset(x, g)); setMedia('cloud'); }} cluster={cluster}
              pin={s.pinGpu} onPin={(v) => set({ pinGpu: v })} start={s.start} />}
          </div>
          <div className="panel-body wizard-nav">
            <button type="button" className="btn" disabled={idx === 0} onClick={() => setStep(VM_STEPS[idx - 1].id)}>Back</button>
            {idx < VM_STEPS.length - 1 && <button type="button" className="btn" onClick={() => setStep(VM_STEPS[idx + 1].id)}>Next: {VM_STEPS[idx + 1].label}</button>}
          </div>
        </section>
      </div>
      <Preview calls={calls} problems={problems} onReview={review} notes={gpuNotes} what={`"Create VM ${s.vmid}"`} />
    </div>
  );
}

function GpuStep({ node, gpu, mappings, mapErr, pci, pciErr, onPick, onPreset, cluster, pin, onPin, start }: {
  node: string; gpu: GpuChoice | null; mappings: PciMapping[] | null; mapErr: unknown; pci: PciDevice[] | null; pciErr: unknown;
  onPick: (g: GpuChoice | null) => void; onPreset: (g: GpuChoice | null) => void; cluster: string;
  pin: boolean; onPin: (v: boolean) => void; start: boolean;
}) {
  const onNode = mappingsOnNode(mappings ?? [], node);
  const others = (mappings ?? []).filter((m) => !onNode.includes(m));
  const displays = (pci ?? []).filter(isDisplay);
  const sel = (g: GpuChoice) => (gpu?.mapping && gpu.mapping === g.mapping) || (gpu?.host && gpu.host === g.host);
  return (
    <>
      <p className="explain">A PCI mapping is the safe choice: it names the card cluster-wide, so HA and migration know which nodes have it. Selecting a GPU switches the VM to q35 and OVMF and turns ballooning off.</p>
      <div className="row-actions">
        <label className="check"><input type="radio" name="gpu" checked={!gpu} onChange={() => onPick(null)} />No GPU</label>
        <button type="button" className="btn btn-sm" disabled={!onNode.length} onClick={() => onPreset(onNode[0] ? { mapping: onNode[0].id, label: onNode[0].id, nodes: mappingNodes(onNode[0]) } : null)}>Use the LLM server preset</button>
      </div>
      <div>
        <div className="section-label">PCI mappings</div>
        {mapErr ? <ApiErrorView error={mapErr} clusterId={cluster} what="PCI mappings" />
          : !mappings ? <div className="muted small" role="status">Loading mappings</div>
            : !mappings.length ? <p className="muted small">No PCI mappings in this cluster. Create one on the Hardware page.</p> : (
              <ul className="choice-list">
                {[...onNode, ...others].map((m) => {
                  const here = onNode.includes(m);
                  const e = mapEntries(m).find((x) => x.node === node) ?? mapEntries(m)[0];
                  const dev = pci?.find((d) => e && d.id.replace(/^0000:/, '') === e.path.replace(/^0000:/, ''));
                  return (
                    <li key={m.id}>
                      <label className={`choice${sel({ mapping: m.id }) ? ' sel' : ''}${here ? '' : ' disabled'}`}>
                        <input type="radio" name="gpu" disabled={!here} checked={!!sel({ mapping: m.id })} onChange={() => onPick({ mapping: m.id, label: m.id, nodes: mappingNodes(m) })} />
                        <span className="grow"><span className="mono">{m.id}</span>{m.description ? <span className="muted"> {m.description}</span> : null}
                          <div className="ws">{here ? `${e?.path}${dev ? `, ${deviceName(dev)}` : ''}${e?.iommugroup ? `, IOMMU group ${e.iommugroup}` : ''}` : `Not on ${node}: ${mapEntries(m).map((x) => x.node).join(', ')}`}</div></span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
      </div>
      {gpu?.mapping && (
        <div className="form-stack">
          <label className="check"><input type="checkbox" checked={pin} onChange={(e) => onPin(e.target.checked)} />Keep this VM on nodes that have this GPU</label>
          <p className="explain">Adds the VM to HA with a strict node-affinity rule for {(gpu.nodes?.length ? gpu.nodes : [node]).join(', ')}: HA then restarts it only on those nodes{start ? ', and starts it once it is created' : ''}. Live migration is not possible with passthrough.</p>
        </div>
      )}
      {gpu?.host && <p className="explain">Keeping a VM on the nodes that have its GPU needs a PCI mapping: HA only knows where a card is through a mapping. Create one on the Hardware page.</p>}
      <div>
        <div className="section-label">Display controllers on {node}</div>
        {pciErr ? (pciErr instanceof ApiError && pciErr.status === 403
          ? <p className="muted small">Listing PCI devices needs Sys.Audit on /. Your account can still use mappings above.</p>
          : <ApiErrorView error={pciErr} clusterId={cluster} what="PCI devices" />)
          : !pci ? <div className="muted small" role="status">Loading PCI devices</div>
            : !displays.length ? <p className="muted small">No display controllers on {node}.</p> : (
              <ul className="choice-list">
                {displays.map((d) => {
                  const mapped = mappingFor(mappings ?? [], node, d.id);
                  const peers = groupPeers(pci, d);
                  const gpuOk = isGpu(d);
                  return (
                    <li key={d.id}>
                      <label className={`choice${sel({ host: d.id }) ? ' sel' : ''}${gpuOk ? '' : ' disabled'}`}>
                        <input type="radio" name="gpu" disabled={!gpuOk} checked={!!sel({ host: d.id })} onChange={() => onPick({ host: d.id, label: `${deviceName(d)} at ${d.id}` })} />
                        <span className="grow">{deviceName(d)} <span className="mono muted">{d.id}</span>
                          <div className="ws">IOMMU group {d.iommugroup}{peers.length ? `, shared with ${peers.length} other device${peers.length === 1 ? '' : 's'}` : ', isolated'}
                            {mapped ? `, mapped as ${mapped.id}` : gpuOk ? ', no mapping (raw device)' : ', board graphics'}</div></span>
                        {gpuOk && <Badge kind="info">GPU</Badge>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
      </div>
    </>
  );
}

// ---------- container ----------

const CT_STEPS = [
  { id: 'general', label: 'General' }, { id: 'template', label: 'Template' }, { id: 'disk', label: 'Root disk' },
  { id: 'cpu', label: 'CPU and memory' }, { id: 'network', label: 'Network' }, { id: 'gpu', label: 'GPU' },
] as const;
type CtStep = (typeof CT_STEPS)[number]['id'];

function CtWizard({ cluster, nodes }: { cluster: string; nodes: string[] }) {
  const { openPlan, me } = useApp();
  const mc = me.clusters.find((c) => c.id === cluster);
  const hostAdmin = !!(mc?.hostAdmin ?? mc?.admin);
  const [s, setS] = useState<CtSpec>(() => defaultCt(nodes[0]));
  const [step, setStep] = useState<CtStep>('general');
  const set = (p: Partial<CtSpec>) => setS((x) => ({ ...x, ...p }));
  const setVmid = useMemo(() => (v: string) => setS((x) => ({ ...x, vmid: v })), []);
  useNextId(cluster, s.vmid, setVmid);
  const roots = useStorages(cluster, s.node, 'rootdir');
  const tmpl = useVolumes(cluster, s.node, 'vztmpl');
  const net = useNetworks(cluster, s.node);
  useEffect(() => {
    const first = roots.data?.[0]?.storage;
    if (first && !roots.data!.some((x) => x.storage === s.rootfs.storage)) setS((x) => ({ ...x, rootfs: { ...x.rootfs, storage: first } }));
  }, [roots.data, s.rootfs.storage]);
  useEffect(() => { if (tmpl.vols?.length && !s.template) setS((x) => ({ ...x, template: tmpl.vols![0].volid })); }, [tmpl.vols, s.template]);

  const calls = ctCalls(s);
  const problems = ctProblems(s);
  const idx = CT_STEPS.findIndex((x) => x.id === step);
  const review = () => void openPlan({
    action: 'api.call', clusterId: cluster,
    params: { title: `Create container ${s.vmid} (${s.hostname}) on ${s.node}`, summary: `${s.unprivileged ? 'Unprivileged' : 'Privileged'} container from ${s.template.split('/').pop()}, ${s.cores} cores, ${formatBytes(s.memoryMiB * 1024 ** 2)} memory, ${s.rootfs.sizeGiB} GiB root disk.${s.gpu.kind !== 'none' ? ` Shares ${ctGpuDevices(s.gpu)[0].split(',')[0]} of ${s.node}.` : ''}`, calls },
  });

  return (
    <div className="wizard">
      <div className="wizard-main">
        <Steps steps={CT_STEPS} value={step} onChange={setStep} />
        <section className="panel" aria-label={CT_STEPS[idx].label}>
          <div className="panel-head"><h2>{CT_STEPS[idx].label}</h2></div>
          <div className="panel-body form-stack">
            {step === 'general' && <>
              <div className="form-row">
                <label className="field"><span className="label">Node</span>
                  <select value={s.node} onChange={(e) => set({ node: e.target.value, template: '' })}>{nodes.map((n) => <option key={n}>{n}</option>)}</select></label>
                <label className="field"><span className="label">CT ID</span><input value={s.vmid} onChange={(e) => set({ vmid: e.target.value.trim() })} inputMode="numeric" /></label>
                <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Hostname</span><input value={s.hostname} onChange={(e) => set({ hostname: e.target.value.trim() })} placeholder="dns02" spellCheck={false} /></label>
              </div>
              <div className="row-actions">
                <label className="check"><input type="checkbox" checked={s.unprivileged} onChange={(e) => set({ unprivileged: e.target.checked })} />Unprivileged (recommended)</label>
                <label className="check"><input type="checkbox" checked={s.nesting} onChange={(e) => set({ nesting: e.target.checked })} />Nesting (needed by systemd in recent distributions)</label>
              </div>
              <label className="field"><span className="label">SSH public keys for root</span>
                <textarea rows={3} value={s.sshKeys} onChange={(e) => set({ sshKeys: e.target.value })} placeholder="ssh-ed25519 AAAA… you@laptop" />
                <span className="hint">One OpenSSH public key per line. galley never asks for a root password; set one later with <code>pct enter {s.vmid || '<id>'}</code> if you need it.</span></label>
              <div className="row-actions">
                <label className="check"><input type="checkbox" checked={s.start} onChange={(e) => set({ start: e.target.checked })} />Start after it is created</label>
                <label className="check"><input type="checkbox" checked={s.onboot} onChange={(e) => set({ onboot: e.target.checked })} />Start when {s.node} boots</label>
              </div>
            </>}
            {step === 'template' && (
              <label className="field"><span className="label">Template</span>
                <select value={s.template} onChange={(e) => set({ template: e.target.value })}>
                  <option value="">{tmpl.vols === null ? 'Loading templates' : tmpl.vols.length ? 'Choose a template' : `No templates on ${s.node}`}</option>
                  {tmpl.vols?.map((v) => <option key={v.volid} value={v.volid}>{v.volid}{v.size ? `, ${formatBytes(v.size)}` : ''}</option>)}
                </select>
                <span className="hint">Download more with <code>pveam update &amp;&amp; pveam available</code> on {s.node}, or from a storage&apos;s CT templates in PVE.</span></label>
            )}
            {step === 'disk' && <>
              {roots.error ? <ApiErrorView error={roots.error} clusterId={cluster} onRetry={roots.reload} what="storages" /> : null}
              <div className="form-row">
                <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Storage</span>
                  <select value={s.rootfs.storage} onChange={(e) => set({ rootfs: { ...s.rootfs, storage: e.target.value } })}>
                    {!roots.data && <option value="">Loading storages</option>}
                    {roots.data?.map((x) => <option key={x.storage} value={x.storage}>{x.storage}, {x.type}{x.shared ? ', shared' : ''}{free(x)}</option>)}
                  </select></label>
                <label className="field"><span className="label">Size (GiB)</span><input type="number" min={1} value={s.rootfs.sizeGiB} onChange={(e) => set({ rootfs: { ...s.rootfs, sizeGiB: numIn(e.target.value) } })} /></label>
              </div>
            </>}
            {step === 'cpu' && (
              <div className="form-row">
                <label className="field"><span className="label">Cores</span><input type="number" min={1} value={s.cores} onChange={(e) => set({ cores: numIn(e.target.value) })} /></label>
                <label className="field"><span className="label">Memory (MiB)</span><input type="number" min={16} step={256} value={s.memoryMiB} onChange={(e) => set({ memoryMiB: numIn(e.target.value) })} /></label>
                <label className="field"><span className="label">Swap (MiB)</span><input type="number" min={0} step={256} value={s.swapMiB} onChange={(e) => set({ swapMiB: numIn(e.target.value) })} /></label>
              </div>
            )}
            {step === 'network' && <>
              {net.error ? <ApiErrorView error={net.error} clusterId={cluster} what="bridges" /> : null}
              <div className="form-row">
                <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Bridge or VNet</span>
                  <NetworkSelect id="ct-br" value={s.net.bridge} onChange={(v) => set({ net: { ...s.net, bridge: v } })} bridges={net.bridges} vnets={net.vnets} /></label>
                <label className="field"><span className="label">VLAN tag (optional)</span><input value={s.net.vlan} onChange={(e) => set({ net: { ...s.net, vlan: e.target.value.trim() } })} placeholder="none" /></label>
                <label className="field"><span className="label">IPv4</span>
                  <select value={s.net.ip} onChange={(e) => set({ net: { ...s.net, ip: e.target.value as 'dhcp' | 'static' } })}><option value="dhcp">DHCP</option><option value="static">Static</option></select></label>
              </div>
              {s.net.ip === 'static' && (
                <div className="form-row">
                  <label className="field"><span className="label">Address/prefix</span><input value={s.net.cidr} onChange={(e) => set({ net: { ...s.net, cidr: e.target.value.trim() } })} placeholder="192.0.2.60/24" /></label>
                  <label className="field"><span className="label">Gateway</span><input value={s.net.gateway} onChange={(e) => set({ net: { ...s.net, gateway: e.target.value.trim() } })} placeholder="192.0.2.1" /></label>
                </div>
              )}
              <label className="check"><input type="checkbox" checked={s.net.firewall} onChange={(e) => set({ net: { ...s.net, firewall: e.target.checked } })} />PVE firewall on this interface</label>
            </>}
            {step === 'gpu' && <>
              <p className="explain">A container shares a GPU with the host: the host keeps its driver and the container gets the device nodes. Several containers can share one card. A GPU passed through to a VM (vfio-pci) cannot be shared.</p>
              <fieldset className="field fieldset"><legend className="label">GPU</legend>
                <div className="row-actions">
                  {([['none', 'No GPU'], ['nvidia', 'Share an NVIDIA GPU (host driver)'], ['dri', 'Share an Intel/AMD GPU (/dev/dri)']] as const).map(([v, l]) => (
                    <label key={v} className="check"><input type="radio" name="ct-gpu" checked={s.gpu.kind === v} onChange={() => set({ gpu: { ...s.gpu, kind: v } })} />{l}</label>))}
                </div>
              </fieldset>
              {s.gpu.kind === 'nvidia' && <>
                <div className="form-row">
                  <label className="field"><span className="label">NVIDIA GPU number</span>
                    <input type="number" min={0} value={s.gpu.index} onChange={(e) => set({ gpu: { ...s.gpu, index: e.target.value === '' ? 0 : Number(e.target.value) } })} />
                    <span className="hint">N in /dev/nvidiaN counts the GPUs on the NVIDIA host driver of {s.node} in PCI order (cards on vfio-pci do not count). Check with <code>nvidia-smi -L</code> on the node.</span></label>
                </div>
                {hostAdmin && <div><button type="button" className="btn btn-sm" onClick={() => void openPlan({ action: 'host.exec', clusterId: cluster, params: { node: s.node, command: 'nvidia-smi -L', reason: 'List the GPUs on the NVIDIA host driver' } })}>Check on {s.node}</button></div>}
                <p className="explain">Adds /dev/nvidia{s.gpu.index}, /dev/nvidiactl, /dev/nvidia-uvm and /dev/nvidia-uvm-tools. The container needs the NVIDIA userland of the same driver version as the host, without the kernel module. <Link to="/help/hardware-and-gpus">How to set it up</Link></p>
              </>}
              {s.gpu.kind === 'dri' && (
                <div className="form-row">
                  <label className="field" style={{ flex: '2 1 220px' }}><span className="label">Render node</span>
                    <input value={s.gpu.dri} onChange={(e) => set({ gpu: { ...s.gpu, dri: e.target.value } })} spellCheck={false} className="mono" /></label>
                  <label className="field"><span className="label">Group id in the container (optional)</span>
                    <input value={s.gpu.gid} onChange={(e) => set({ gpu: { ...s.gpu, gid: e.target.value.trim() } })} inputMode="numeric" placeholder="render group, e.g. 104" /></label>
                </div>
              )}
              {s.gpu.kind !== 'none' && <p className="explain">A shared GPU has no PCI mapping, so galley does not pin the container to this node with HA. Keep it out of HA, or pin it yourself.</p>}
            </>}
          </div>
          <div className="panel-body wizard-nav">
            <button type="button" className="btn" disabled={idx === 0} onClick={() => setStep(CT_STEPS[idx - 1].id)}>Back</button>
            {idx < CT_STEPS.length - 1 && <button type="button" className="btn" onClick={() => setStep(CT_STEPS[idx + 1].id)}>Next: {CT_STEPS[idx + 1].label}</button>}
          </div>
        </section>
      </div>
      <Preview calls={calls} problems={problems} onReview={review} what={`"Create container ${s.vmid}"`} />
    </div>
  );
}
