// PCI devices (GET /nodes/{node}/hardware/pci) and cluster PCI mappings (GET /cluster/mapping/pci).
import { parsePropString } from './guestConfig';

export interface PciDevice {
  id: string;
  class: string;
  vendor?: string;
  device?: string;
  vendor_name?: string;
  device_name?: string;
  subsystem_device_name?: string;
  subsystem_vendor?: string;
  subsystem_device?: string;
  iommugroup: number;
  mdev?: boolean | number;
}

export interface PciMapping { id: string; description?: string; map: string[] | string }

export interface MapEntry { node: string; path: string; id?: string; iommugroup?: string; subsystemId?: string }

/** PCI class 0x03xxxx: VGA, XGA and 3D controllers. */
export const isDisplay = (d: Pick<PciDevice, 'class'>) => /^0x03/.test(d.class);

/** A GPU worth passing through: a display controller that is not the board's management VGA. */
export const isGpu = (d: PciDevice) => isDisplay(d) && !/ASPEED|Matrox|G200/i.test(`${d.vendor_name} ${d.device_name}`);

export function mapEntries(m: PciMapping): MapEntry[] {
  const list = Array.isArray(m.map) ? m.map : String(m.map ?? '').split(/\n/);
  return list.filter(Boolean).map((s) => {
    const p = parsePropString(s, 'node');
    return { node: p.node ?? '', path: p.path ?? '', ...(p.id ? { id: p.id } : {}), ...(p.iommugroup ? { iommugroup: p.iommugroup } : {}), ...(p['subsystem-id'] ? { subsystemId: p['subsystem-id'] } : {}) };
  });
}

/** The mapping that covers a device on a node ("0000:16:00.0" also matches "16:00.0"). */
export function mappingFor(mappings: PciMapping[], node: string, path: string): PciMapping | undefined {
  const norm = (x: string) => x.replace(/^0000:/, '').toLowerCase();
  return mappings.find((m) => mapEntries(m).some((e) => e.node === node && norm(e.path) === norm(path)));
}

/** Mappings usable on a node (they have an entry for it). */
export const mappingsOnNode = (mappings: PciMapping[], node: string) => mappings.filter((m) => mapEntries(m).some((e) => e.node === node));

/** Other devices in the same IOMMU group: passthrough hands the whole group to the guest. */
export const groupPeers = (devices: PciDevice[], d: PciDevice) =>
  devices.filter((x) => x.iommugroup === d.iommugroup && x.id !== d.id && x.iommugroup >= 0 && !x.id.startsWith(d.id.slice(0, -1)));

export const deviceName = (d: PciDevice) => `${d.vendor_name ?? d.vendor ?? ''} ${d.subsystem_device_name && !/^0x/.test(d.subsystem_device_name) ? d.subsystem_device_name : d.device_name ?? d.device ?? ''}`.trim();

const hex = (v?: string) => (v ?? '').replace(/^0x/, '');

/** The map entry PVE expects for a new mapping of a device: node=…,path=…,id=vendor:device,iommugroup=…[,subsystem-id=…] */
export function mapLine(node: string, d: PciDevice): string {
  const parts = [`node=${node}`, `path=${d.id}`, `id=${hex(d.vendor)}:${hex(d.device)}`, `iommugroup=${d.iommugroup}`];
  if (d.subsystem_vendor && d.subsystem_device) parts.push(`subsystem-id=${hex(d.subsystem_vendor)}:${hex(d.subsystem_device)}`);
  return parts.join(',');
}

/** A suggested mapping id: gpu-a2-1 style, unique among existing mappings. */
export function suggestMappingId(d: PciDevice, mappings: PciMapping[]): string {
  const model = (d.subsystem_device_name && !/^0x/.test(d.subsystem_device_name) ? d.subsystem_device_name : (d.device_name ?? 'pci').replace(/.*\[(.+?)\].*/, '$1').split(/[\s/]/)[0])
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pci';
  const base = `${isDisplay(d) ? 'gpu' : 'pci'}-${model}`;
  for (let i = 0; ; i++) if (!mappings.some((m) => m.id === `${base}-${i}`)) return `${base}-${i}`;
}

/** hostpciN values in a guest config that reference a mapping or a raw device. */
export function hostpciRefs(cfg: Record<string, unknown>): { key: string; mapping?: string; host?: string }[] {
  return Object.entries(cfg).filter(([k]) => /^hostpci\d+$/.test(k)).map(([key, v]) => {
    const p = parsePropString(String(v), 'host');
    return { key, ...(p.mapping ? { mapping: p.mapping } : {}), ...(p.host ? { host: p.host } : {}) };
  });
}
