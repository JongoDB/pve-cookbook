// HA pinning for VMs with a passed-through device: an HA resource plus a strict
// node-affinity rule (PVE 9, /cluster/ha/rules) for the nodes that have the card.
import type { ApiCall } from './wizard';
import { mapEntries, type PciMapping } from './pci';

/** GET /cluster/ha/rules entry (PVE 9). */
export interface HaRule {
  rule: string;
  type: string;
  resources?: string;
  /** node-affinity: "pve1,pve2" or with priorities "pve1:2,pve2:1" */
  nodes?: string;
  strict?: number | boolean;
  disable?: number | boolean;
  comment?: string;
}

/** GET /cluster/ha/resources entry. */
export interface HaResource { sid: string; state?: string; type?: string }

export const vmSid = (vmid: number | string) => `vm:${vmid}`;

const list = (s?: string) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** Node names of a node-affinity rule, priorities dropped. */
export const ruleNodes = (r: HaRule) => list(r.nodes).map((n) => n.split(':')[0]);

/** The enabled node-affinity rule that names this VM, if any. */
export const pinRuleFor = (rules: HaRule[], vmid: number | string) =>
  rules.find((r) => r.type === 'node-affinity' && !Number(r.disable ?? 0) && list(r.resources).includes(vmSid(vmid)));

/** Nodes a PCI mapping has a device on (from its map entries' node=…), in map order. */
export const mappingNodes = (m: Pick<PciMapping, 'map'>) => [...new Set(mapEntries({ id: '', ...m }).map((e) => e.node).filter(Boolean))];

/** A rule id that PVE accepts (pve-configid) and that is not taken: gpu-300, gpu-300-2, … */
export function pinRuleId(vmid: number | string, taken: string[] = []): string {
  const base = `gpu-${String(vmid).replace(/[^0-9a-z_-]/gi, '').toLowerCase()}`;
  if (!taken.includes(base)) return base;
  for (let i = 2; ; i++) if (!taken.includes(`${base}-${i}`)) return `${base}-${i}`;
}

export interface PinSpec {
  vmid: number | string;
  mapping: string;
  nodes: string[];
  /** requested HA state for a new HA resource */
  state: 'started' | 'stopped';
  /** the VM is already an HA resource: only the rule is added */
  haResource?: boolean;
  /** rule ids already in use */
  takenRules?: string[];
}

/** The calls that keep a VM on the nodes that have its mapped device. */
export function pinCalls(p: PinSpec): ApiCall[] {
  const sid = vmSid(p.vmid);
  const calls: ApiCall[] = [];
  if (!p.haResource) calls.push({ method: 'POST', path: '/cluster/ha/resources', body: { sid, state: p.state } });
  calls.push({
    method: 'POST', path: '/cluster/ha/rules',
    body: { rule: pinRuleId(p.vmid, p.takenRules), type: 'node-affinity', resources: sid, nodes: p.nodes.join(','), strict: '1', comment: `galley: ${p.mapping} only exists on these nodes` },
  });
  return calls;
}
