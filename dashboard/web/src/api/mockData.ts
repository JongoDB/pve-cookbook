// Demo data for mock mode: PCI devices, mappings, SDN, host keys and the assistant's scripted answers.
// Generic only: two NVIDIA A2 GPUs on pve1, no real hosts or keys.

export interface MockPci {
  id: string; class: string; vendor: string; device: string; vendor_name: string; device_name: string;
  subsystem_vendor?: string; subsystem_device?: string; subsystem_device_name?: string; iommugroup: number; mdev?: boolean;
}

const nic = (id: string, group: number): MockPci => ({
  id, class: '0x020000', vendor: '0x8086', device: '0x1572', vendor_name: 'Intel Corporation', device_name: 'Ethernet Controller X710 for 10GbE SFP+', iommugroup: group,
});

export function mockPci(node: string): MockPci[] {
  const common: MockPci[] = [
    { id: '0000:03:00.0', class: '0x030000', vendor: '0x1a03', device: '0x2000', vendor_name: 'ASPEED Technology, Inc.', device_name: 'ASPEED Graphics Family', iommugroup: 30 },
    nic('0000:41:00.0', 44), nic('0000:41:00.1', 45),
    { id: '0000:c1:00.0', class: '0x010802', vendor: '0x144d', device: '0xa80c', vendor_name: 'Samsung Electronics Co Ltd', device_name: 'NVMe SSD Controller S4LV008[Pascal]', iommugroup: 60 },
    { id: '0000:00:00.0', class: '0x060000', vendor: '0x8086', device: '0x2020', vendor_name: 'Intel Corporation', device_name: 'Sky Lake-E DMI3 Registers', iommugroup: 0 },
    { id: '0000:15:00.0', class: '0x060400', vendor: '0x8086', device: '0x2030', vendor_name: 'Intel Corporation', device_name: 'Sky Lake-E PCI Express Root Port A', iommugroup: 9 },
    { id: '0000:00:14.0', class: '0x0c0330', vendor: '0x8086', device: '0xa1af', vendor_name: 'Intel Corporation', device_name: 'C620 Series Chipset Family USB 3.0 xHCI Controller', iommugroup: 12 },
  ];
  if (node !== 'pve1') return common;
  const a2 = (id: string, group: number): MockPci => ({
    id, class: '0x030200', vendor: '0x10de', device: '0x25b6', vendor_name: 'NVIDIA Corporation', device_name: 'GA107GL [A2 / A16]',
    subsystem_vendor: '0x10de', subsystem_device: '0x157e', subsystem_device_name: 'A2', iommugroup: group,
  });
  return [...common, a2('0000:16:00.0', 10), a2('0000:91:00.0', 1)];
}

export interface MockMapping { id: string; description?: string; map: string[] }

export const seedMappings = (): MockMapping[] => [
  { id: 'gpu-a2-0', description: 'NVIDIA A2 in slot 2 of pve1', map: ['node=pve1,path=0000:16:00.0,id=10de:25b6,iommugroup=10,subsystem-id=10de:157e'] },
];

export const mockVnets = () => [
  { vnet: 'vnet-ai', zone: 'lab', type: 'vnet', tag: 40, alias: 'AI workloads' },
  { vnet: 'vnet-dmz', zone: 'lab', type: 'vnet', tag: 50, alias: 'Public services' },
];

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
/** A stable fake SHA256 host key fingerprint per node (43 base64 characters, like ssh-keygen -l). */
export function hostFingerprint(cluster: string, node: string): string {
  let h = 2166136261;
  let out = '';
  for (let i = 0; i < 43; i++) {
    const s = `${cluster}/${node}/${i}`;
    for (let j = 0; j < s.length; j++) { h ^= s.charCodeAt(j); h = Math.imul(h, 16777619); }
    out += B64[(h >>> 0) % 64];
  }
  return `SHA256:${out}`;
}

export const mockAuthorizedKey = (cluster: string) =>
  `restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKeyOnlyNotARealKey${cluster.replace(/[^a-z0-9]/gi, '')}0000 galley@${cluster}`;

export const MOCK_HOST_OUTPUT = `$ ethtool -a enp65s0f0
Pause parameters for enp65s0f0:
Autonegotiate:	off
RX:		off
TX:		off
`;

// ---- assistant script ----

export type ScriptStep =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input: Record<string, unknown>; error?: string }
  | { kind: 'change' };

export function assistantScript(message: string): { steps: ScriptStep[]; change?: 'gpu' } {
  const m = message.toLowerCase();
  if (/gpu|a2|second card|passthrough/.test(m)) {
    return {
      change: 'gpu',
      steps: [
        { kind: 'tool', name: 'pve_get', input: { cluster: 'pve-lab', path: '/nodes/pve1/qemu/300/config' } },
        { kind: 'tool', name: 'pve_get', input: { cluster: 'pve-lab', path: '/nodes/pve1/hardware/pci' } },
        { kind: 'tool', name: 'pve_get', input: { cluster: 'pve-lab', path: '/cluster/mapping/pci' } },
        { kind: 'text', text: 'llm-vllm (300) has one A2 attached as `hostpci0` through mapping **gpu-a2-0**. The second A2 on pve1 sits at `0000:91:00.0`, alone in IOMMU group 1, so it can be passed through cleanly. It has no mapping yet.\n\nI drafted a change with two steps:\n\n1. Create the PCI mapping `gpu-a2-1` for `0000:91:00.0` on pve1.\n2. Add it to 300 as `hostpci1` with `pcie=1`.\n\n' },
        { kind: 'tool', name: 'propose_change', input: { cluster: 'pve-lab', title: 'Attach the second GPU to llm-vllm' } },
        { kind: 'change' },
        { kind: 'text', text: 'The VM picks up the new device at its next start, so plan a restart after you apply it. VM 300 already runs q35 with OVMF and ballooning off, which passthrough needs.' },
      ],
    };
  }
  if (/fail|broken|error/.test(m)) {
    return {
      steps: [
        { kind: 'tool', name: 'list_tasks', input: { cluster: 'pve-lab', limit: 50 } },
        { kind: 'tool', name: 'pve_get', input: { cluster: 'pve-lab', path: '/nodes/pve2/lxc/999/status/current' }, error: '403 Permission check failed (/vms/999, VM.Audit)' },
        { kind: 'text', text: 'One task failed in the last hour: `vzstart` of container **999** (sandbox) on pve2, with `command \'lxc-start\' failed: exit code 1`.\n\nI could not read its status: your PVE account lacks `VM.Audit` on `/vms/999`. To see why it failed, open the task log on pve2 or run:\n\n```\npct start 999 --debug\n```' },
      ],
    };
  }
  return {
    steps: [
      { kind: 'tool', name: 'get_findings', input: {} },
      { kind: 'tool', name: 'get_metrics', input: { cluster: 'pve-lab', kind: 'node', id: 'pve1', timeframe: 'hour' } },
      { kind: 'text', text: 'Two things need you on **pve-lab**:\n\n- Storage `nas-backup` is not available on pve1, pve2 or pve3. Backups that target it will fail tonight.\n- grafana (131) is not in any backup job: it is on the exclude list of `nightly-all`.\n\npve1 logged 33 corosync retransmits in 10 minutes. Corosync shares its only link with guest traffic, so bursts will recur until it has a dedicated link.\n\nTo check the NFS server from a node:\n\n```\nshowmount -e 192.0.2.40\npvesm status --storage nas-backup\n```' },
    ],
  };
}
