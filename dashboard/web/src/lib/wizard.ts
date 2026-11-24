// Create wizards → api.call changes. Pure so the exact calls can be tested and previewed.
import { pveshCli, type Body } from './schemaForm';

export interface ApiCall { method: 'POST' | 'PUT' | 'DELETE'; path: string; body: Body }

export interface GpuChoice {
  /** a cluster PCI resource mapping id (preferred: survives slot changes, works with HA) */
  mapping?: string;
  /** or a raw host device, e.g. 0000:16:00.0 */
  host?: string;
  /** shown in previews and notes */
  label?: string;
}

export interface VmSpec {
  node: string;
  vmid: string;
  name: string;
  ostype: string;
  cores: number;
  sockets: number;
  cpuType: string;
  memoryMiB: number;
  /** minimum memory for ballooning in MiB; 0 turns ballooning off; null leaves PVE's default */
  balloonMiB: number | null;
  machine: 'q35' | 'pc';
  bios: 'ovmf' | 'seabios';
  /** storage for the EFI vars disk (OVMF only) */
  efiStorage: string;
  /** importFrom: a disk image volume (e.g. local:import/debian-13-genericcloud-amd64.qcow2) to copy as the boot disk */
  disk: { storage: string; sizeGiB: number; iothread: boolean; discard: boolean; ssd: boolean; importFrom: string };
  net: { bridge: string; model: string; vlan: string; firewall: boolean };
  /** ISO volume id, e.g. cephfs:iso/debian-13.1.0-amd64-netinst.iso */
  iso: string;
  cloudInit: { enabled: boolean; storage: string; user: string; sshKeys: string; ip: 'dhcp' | 'static'; cidr: string; gateway: string };
  gpu: GpuChoice | null;
  start: boolean;
  onboot: boolean;
  tags: string;
}

export const defaultVm = (node = ''): VmSpec => ({
  node, vmid: '', name: '', ostype: 'l26', cores: 2, sockets: 1, cpuType: 'host', memoryMiB: 4096, balloonMiB: null,
  machine: 'q35', bios: 'ovmf', efiStorage: '',
  disk: { storage: '', sizeGiB: 32, iothread: true, discard: true, ssd: true, importFrom: '' },
  net: { bridge: 'vmbr0', model: 'virtio', vlan: '', firewall: true },
  iso: '', cloudInit: { enabled: false, storage: '', user: '', sshKeys: '', ip: 'dhcp', cidr: '', gateway: '' },
  gpu: null, start: false, onboot: false, tags: '',
});

/**
 * Attaching a GPU: q35 + OVMF (PCIe passthrough needs both), ballooning off (passthrough pins
 * all guest memory, so the balloon cannot reclaim any) and CPU type host.
 */
export function withGpu(s: VmSpec, gpu: GpuChoice | null): VmSpec {
  if (!gpu) return { ...s, gpu: null };
  return { ...s, gpu, machine: 'q35', bios: 'ovmf', balloonMiB: 0, cpuType: 'host' };
}

/** "LLM server": one GPU, 16 cores, 64 GiB, 200 GiB disk, cloud-init for a Debian/Ubuntu cloud image. */
export function llmPreset(s: VmSpec, gpu: GpuChoice | null): VmSpec {
  return withGpu({
    ...s,
    name: s.name || 'llm-server', ostype: 'l26', cores: Math.max(16, s.cores), sockets: 1, memoryMiB: Math.max(65536, s.memoryMiB),
    disk: { ...s.disk, sizeGiB: Math.max(200, s.disk.sizeGiB), iothread: true, discard: true, ssd: true },
    cloudInit: { ...s.cloudInit, enabled: true, storage: s.cloudInit.storage || s.disk.storage },
    tags: s.tags || 'gpu;ai',
  }, gpu);
}

const flag = (b: boolean) => (b ? '1' : '0');

export function vmProblems(s: VmSpec): string[] {
  const p: string[] = [];
  if (!s.node) p.push('Choose a node.');
  if (!/^\d+$/.test(s.vmid) || Number(s.vmid) < 100 || Number(s.vmid) > 999999999) p.push('VMID must be a number from 100 to 999999999.');
  if (s.name && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s.name)) p.push('Name must be a DNS name: letters, digits, dots and hyphens.');
  if (!s.disk.storage) p.push('Choose a storage for the disk.');
  if (!(s.disk.sizeGiB >= 1)) p.push('Disk size must be at least 1 GiB.');
  if (s.bios === 'ovmf' && !(s.efiStorage || s.disk.storage)) p.push('Choose a storage for the EFI disk.');
  if (!(s.cores >= 1)) p.push('At least 1 core.');
  if (!(s.memoryMiB >= 16)) p.push('Memory must be at least 16 MiB.');
  if (s.balloonMiB && s.balloonMiB > s.memoryMiB) p.push('The balloon minimum cannot exceed memory.');
  if (!s.net.bridge) p.push('Choose a bridge or VNet.');
  if (s.net.vlan && !/^\d+$/.test(s.net.vlan)) p.push('VLAN tag must be a number.');
  if (s.gpu && (s.machine !== 'q35' || s.bios !== 'ovmf')) p.push('GPU passthrough needs machine q35 and OVMF.');
  if (s.cloudInit.enabled && s.cloudInit.ip === 'static' && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s.cloudInit.cidr)) p.push('Static address must look like 192.0.2.50/24.');
  return p;
}

/** The one create call for a VM. Starting is the `start` parameter of the same call. */
export function vmCalls(s: VmSpec): ApiCall[] {
  const b: Body = {
    vmid: s.vmid,
    ostype: s.ostype,
    cores: String(s.cores),
    cpu: s.cpuType,
    memory: String(s.memoryMiB),
    machine: s.machine,
    bios: s.bios,
    scsihw: 'virtio-scsi-single',
    agent: '1',
  };
  if (s.name) b.name = s.name;
  if (s.sockets > 1) b.sockets = String(s.sockets);
  if (s.balloonMiB !== null) b.balloon = String(s.balloonMiB);
  if (s.bios === 'ovmf') b.efidisk0 = `${s.efiStorage || s.disk.storage}:1,efitype=4m,pre-enrolled-keys=0`;
  // import-from copies an image as the disk; the size then comes from the image (grow it later)
  const disk = [s.disk.importFrom ? `${s.disk.storage}:0,import-from=${s.disk.importFrom}` : `${s.disk.storage}:${s.disk.sizeGiB}`];
  if (s.disk.iothread) disk.push('iothread=1');
  if (s.disk.discard) disk.push('discard=on');
  if (s.disk.ssd) disk.push('ssd=1');
  b.scsi0 = disk.join(',');
  const net = [s.net.model, `bridge=${s.net.bridge}`];
  if (s.net.vlan) net.push(`tag=${s.net.vlan}`);
  if (s.net.firewall) net.push('firewall=1');
  b.net0 = net.join(',');
  const boot = ['scsi0'];
  if (s.iso) { b.ide2 = `${s.iso},media=cdrom`; boot.push('ide2'); }
  boot.push('net0');
  b.boot = `order=${boot.join(';')}`;
  if (s.cloudInit.enabled) {
    b[s.iso ? 'ide0' : 'ide2'] = `${s.cloudInit.storage || s.disk.storage}:cloudinit`;
    if (s.cloudInit.user) b.ciuser = s.cloudInit.user;
    // PVE expects sshkeys URL-encoded (one OpenSSH public key per line)
    if (s.cloudInit.sshKeys.trim()) b.sshkeys = encodeURIComponent(s.cloudInit.sshKeys.trim());
    b.ipconfig0 = s.cloudInit.ip === 'dhcp' ? 'ip=dhcp' : `ip=${s.cloudInit.cidr}${s.cloudInit.gateway ? `,gw=${s.cloudInit.gateway}` : ''}`;
  }
  if (s.gpu) b.hostpci0 = `${s.gpu.mapping ? `mapping=${s.gpu.mapping}` : s.gpu.host},pcie=1`;
  if (s.onboot) b.onboot = '1';
  if (s.tags.trim()) b.tags = s.tags.trim().split(/[\s,;]+/).filter(Boolean).join(';');
  if (s.start) b.start = '1';
  return [{ method: 'POST', path: `/nodes/${s.node}/qemu`, body: b }];
}

// ---- containers ----

export interface CtSpec {
  node: string;
  vmid: string;
  hostname: string;
  /** vztmpl volume id */
  template: string;
  unprivileged: boolean;
  nesting: boolean;
  cores: number;
  memoryMiB: number;
  swapMiB: number;
  rootfs: { storage: string; sizeGiB: number };
  net: { bridge: string; vlan: string; ip: 'dhcp' | 'static'; cidr: string; gateway: string; firewall: boolean };
  /** OpenSSH public keys, one per line. galley never asks for a root password. */
  sshKeys: string;
  start: boolean;
  onboot: boolean;
  tags: string;
}

export const defaultCt = (node = ''): CtSpec => ({
  node, vmid: '', hostname: '', template: '', unprivileged: true, nesting: true, cores: 1, memoryMiB: 1024, swapMiB: 512,
  rootfs: { storage: '', sizeGiB: 8 }, net: { bridge: 'vmbr0', vlan: '', ip: 'dhcp', cidr: '', gateway: '', firewall: true },
  sshKeys: '', start: true, onboot: false, tags: '',
});

export function ctProblems(s: CtSpec): string[] {
  const p: string[] = [];
  if (!s.node) p.push('Choose a node.');
  if (!/^\d+$/.test(s.vmid) || Number(s.vmid) < 100) p.push('CT ID must be a number from 100.');
  if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s.hostname)) p.push('Hostname must be a DNS name.');
  if (!s.template) p.push('Choose a template.');
  if (!s.rootfs.storage) p.push('Choose a storage for the root disk.');
  if (!(s.rootfs.sizeGiB >= 1)) p.push('Root disk must be at least 1 GiB.');
  if (!s.net.bridge) p.push('Choose a bridge or VNet.');
  if (s.net.ip === 'static' && !/^\d+\.\d+\.\d+\.\d+\/\d+$/.test(s.net.cidr)) p.push('Static address must look like 192.0.2.50/24.');
  if (!s.sshKeys.trim()) p.push('Add at least one SSH public key: galley does not set root passwords.');
  else if (s.sshKeys.split('\n').some((l) => l.trim() && !/^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-\S+|sk-\S+) \S+/.test(l.trim()))) p.push('Every SSH key line must be an OpenSSH public key (ssh-ed25519 AAAA…).');
  if (/PRIVATE KEY/.test(s.sshKeys)) p.push('That is a private key. Paste the public key (.pub) only.');
  return p;
}

export function ctCalls(s: CtSpec): ApiCall[] {
  const net = ['name=eth0', `bridge=${s.net.bridge}`];
  net.push(s.net.ip === 'dhcp' ? 'ip=dhcp' : `ip=${s.net.cidr}`);
  if (s.net.ip === 'static' && s.net.gateway) net.push(`gw=${s.net.gateway}`);
  if (s.net.vlan) net.push(`tag=${s.net.vlan}`);
  if (s.net.firewall) net.push('firewall=1');
  const b: Body = {
    vmid: s.vmid,
    hostname: s.hostname,
    ostemplate: s.template,
    unprivileged: flag(s.unprivileged),
    cores: String(s.cores),
    memory: String(s.memoryMiB),
    swap: String(s.swapMiB),
    rootfs: `${s.rootfs.storage}:${s.rootfs.sizeGiB}`,
    net0: net.join(','),
    'ssh-public-keys': s.sshKeys.trim(),
  };
  if (s.nesting) b.features = 'nesting=1';
  if (s.onboot) b.onboot = '1';
  if (s.tags.trim()) b.tags = s.tags.trim().split(/[\s,;]+/).filter(Boolean).join(';');
  if (s.start) b.start = '1';
  return [{ method: 'POST', path: `/nodes/${s.node}/lxc`, body: b }];
}

export const callsCli = (calls: ApiCall[]) => calls.map((c) => pveshCli(c.method, c.path, c.body)).join('\n');
