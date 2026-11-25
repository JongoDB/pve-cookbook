// Turns a PVE guest config (GET nodes/{node}/{qemu|lxc}/{vmid}/config) into labelled rows.
import type { GuestType } from '../api/types';
import { formatBytes, parseSize } from './units';

export type ConfigValue = string | number | undefined;
export type RawConfig = Record<string, ConfigValue>;

/** "local-zfs:vm-1-disk-0,iothread=1,size=200G" → { _: 'local-zfs:vm-1-disk-0', iothread: '1', size: '200G' } */
export function parsePropString(v: ConfigValue, defaultKey = '_'): Record<string, string> {
  const out: Record<string, string> = {};
  if (v === undefined || v === null) return out;
  for (const part of String(v).split(',')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) { if (!(defaultKey in out)) out[defaultKey] = part; else out[part] = ''; }
    else out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export interface Disk {
  key: string;
  bus: string;
  storage: string;
  volume: string;
  size: number | null;
  media?: string;
  /** mount point for LXC mpN / rootfs */
  mountpoint?: string;
  options: Record<string, string>;
}

export interface Nic {
  key: string;
  model?: string;
  mac?: string;
  bridge?: string;
  vlan?: string;
  firewall: boolean;
  rate?: string;
  /** LXC */
  name?: string;
  ip?: string;
}

export interface PciDevice { key: string; host?: string; mapping?: string; pcie: boolean; primaryGpu: boolean; options: Record<string, string> }

export interface GuestHardware {
  cores: number;
  sockets: number;
  cpuType: string;
  vcpus?: number;
  cpulimit?: string;
  memory: number | null;
  balloon: number | null | 'off';
  swap?: number | null;
  machine?: string;
  bios?: string;
  scsihw?: string;
  ostype?: string;
  disks: Disk[];
  nets: Nic[];
  hostpci: PciDevice[];
  /** config keys not shown as hardware (and not internal) */
  options: [string, string][];
}

const DISK_RE = /^(scsi|virtio|sata|ide|efidisk|tpmstate)(\d+)$|^(rootfs)$|^(mp)(\d+)$|^(unused)(\d+)$/;
const HW_KEYS = new Set(['cores', 'sockets', 'cpu', 'vcpus', 'cpulimit', 'memory', 'balloon', 'swap', 'machine', 'bios', 'scsihw', 'ostype', 'arch']);
const HIDDEN_KEYS = new Set(['digest', 'lock']);

const num = (v: ConfigValue) => (v === undefined || v === '' ? undefined : Number(v));

function keyOrder(a: string, b: string) {
  const [, pa, na] = /^([a-z]+)(\d*)$/.exec(a) ?? [a, a, ''];
  const [, pb, nb] = /^([a-z]+)(\d*)$/.exec(b) ?? [b, b, ''];
  return pa === pb ? Number(na || 0) - Number(nb || 0) : pa.localeCompare(pb);
}

export function parseGuestConfig(type: GuestType, cfg: RawConfig): GuestHardware {
  const disks: Disk[] = [];
  const nets: Nic[] = [];
  const hostpci: PciDevice[] = [];
  const options: [string, string][] = [];

  for (const key of Object.keys(cfg).sort(keyOrder)) {
    const v = cfg[key];
    if (v === undefined || HIDDEN_KEYS.has(key)) continue;
    const dm = DISK_RE.exec(key);
    if (dm) {
      const bus = dm[1] ?? dm[3] ?? dm[4] ?? dm[6];
      const p = parsePropString(v, bus === 'rootfs' || bus === 'mp' ? 'volume' : '_');
      const vol = p._ ?? p.volume ?? '';
      delete p._; delete p.volume;
      const colon = vol.indexOf(':');
      const storage = colon >= 0 ? vol.slice(0, colon) : vol === 'none' ? '' : vol;
      const { size, media, mp, ...rest } = p;
      disks.push({
        key, bus, storage, volume: colon >= 0 ? vol.slice(colon + 1) : vol,
        size: parseSize(size), ...(media ? { media } : {}), ...(mp ? { mountpoint: mp } : bus === 'rootfs' ? { mountpoint: '/' } : {}),
        options: rest,
      });
      continue;
    }
    if (/^net\d+$/.test(key)) {
      const p = parsePropString(v, 'model');
      let model: string | undefined;
      let mac: string | undefined;
      if (type === 'qemu') {
        // "virtio=BC:24:11:00:00:01,bridge=vmbr0": the model key carries the MAC
        for (const m of ['virtio', 'e1000', 'e1000e', 'rtl8139', 'vmxnet3', 'model']) {
          if (m in p) { model = m === 'model' ? p.model : m; mac = m === 'model' ? p.macaddr : p[m] || p.macaddr; break; }
        }
      } else {
        model = p.type ?? 'veth';
        mac = p.hwaddr;
      }
      nets.push({
        key, model, mac, bridge: p.bridge, vlan: p.tag, firewall: p.firewall === '1', rate: p.rate,
        ...(type === 'lxc' ? { name: p.name, ip: [p.ip, p.ip6].filter(Boolean).join(', ') || undefined } : {}),
      });
      continue;
    }
    if (/^hostpci\d+$/.test(key)) {
      const p = parsePropString(v, 'host');
      const { host, mapping, pcie, 'x-vga': xvga, ...rest } = p;
      hostpci.push({ key, ...(host ? { host } : {}), ...(mapping ? { mapping } : {}), pcie: pcie === '1', primaryGpu: xvga === '1', options: rest });
      continue;
    }
    if (HW_KEYS.has(key)) continue;
    options.push([key, String(v)]);
  }

  const balloonRaw = num(cfg.balloon);
  const memory = num(cfg.memory);
  return {
    cores: num(cfg.cores) ?? 1,
    sockets: num(cfg.sockets) ?? 1,
    cpuType: cfg.cpu !== undefined ? parsePropString(cfg.cpu, 'cputype').cputype ?? String(cfg.cpu) : type === 'qemu' ? 'kvm64 (default)' : 'host',
    ...(cfg.vcpus !== undefined ? { vcpus: num(cfg.vcpus) } : {}),
    ...(cfg.cpulimit !== undefined ? { cpulimit: String(cfg.cpulimit) } : {}),
    memory: memory !== undefined ? memory * 1024 ** 2 : null,
    balloon: balloonRaw === 0 ? 'off' : balloonRaw !== undefined ? balloonRaw * 1024 ** 2 : null,
    ...(type === 'lxc' ? { swap: num(cfg.swap) !== undefined ? (num(cfg.swap) as number) * 1024 ** 2 : null } : {}),
    ...(cfg.machine !== undefined ? { machine: String(cfg.machine) } : {}),
    ...(cfg.bios !== undefined ? { bios: String(cfg.bios) } : {}),
    ...(cfg.scsihw !== undefined ? { scsihw: String(cfg.scsihw) } : {}),
    ...(cfg.ostype !== undefined ? { ostype: String(cfg.ostype) } : {}),
    disks, nets, hostpci, options,
  };
}

/** One-line description of a disk: "local-zfs, 200 GiB, iothread". */
export function describeDisk(d: Disk): string {
  if (d.media === 'cdrom') return d.volume && d.volume !== 'none' ? `CD/DVD, ${d.storage ? `${d.storage}:` : ''}${d.volume}` : 'CD/DVD, empty';
  const parts = [d.storage || d.volume];
  if (d.size !== null) parts.push(formatBytes(d.size));
  if (d.mountpoint && d.bus !== 'rootfs') parts.push(`mounted at ${d.mountpoint}`);
  for (const k of ['iothread', 'ssd', 'discard', 'cache', 'backup', 'replicate']) {
    if (k in d.options) parts.push(k === 'cache' ? `cache ${d.options[k]}` : k === 'backup' && d.options[k] === '0' ? 'not in backups' : k === 'discard' ? `discard ${d.options[k]}` : d.options[k] === '1' ? k : '');
  }
  return parts.filter(Boolean).join(', ');
}

export function describeNic(n: Nic): string {
  return [
    n.name, n.model, n.bridge ? `bridge ${n.bridge}` : '', n.vlan ? `VLAN ${n.vlan}` : '', n.ip, n.firewall ? 'firewall on' : '', n.rate ? `limit ${n.rate} MB/s` : '',
  ].filter(Boolean).join(', ');
}

export function describePci(p: PciDevice): string {
  return [p.mapping ? `mapping ${p.mapping}` : p.host ? `host ${p.host}` : '', p.pcie ? 'PCIe' : '', p.primaryGpu ? 'primary GPU' : ''].filter(Boolean).join(', ');
}
