import { describe, expect, it } from 'vitest';
import type { Guest } from '../api/types';
import { parseCommand } from './commands';

const mk = (clusterId: string, vmid: number, name: string, type: 'qemu' | 'lxc', node: string, status = 'running'): Guest => ({
  clusterId, vmid, name, type, node, status, cpu: 0, maxcpu: 1, mem: 0, maxmem: 1, disk: 0, maxdisk: 1, uptime: 0, tags: [], template: false,
});

const guests = [
  mk('lab', 120, 'web01', 'qemu', 'pve1'),
  mk('lab', 121, 'web02', 'qemu', 'pve2'),
  mk('lab', 131, 'grafana', 'lxc', 'pve2', 'stopped'),
  mk('edge', 200, 'edge-proxy', 'lxc', 'edge1'),
  mk('edge', 120, 'other-120', 'lxc', 'edge1'),
  { ...mk('lab', 9000, 'tpl', 'qemu', 'pve1', 'stopped'), template: true },
];
const nodes = { lab: ['pve1', 'pve2', 'pve3'], edge: ['edge1'] };

describe('parseCommand', () => {
  it('ignores plain search text', () => {
    expect(parseCommand('grafana', guests, nodes).kind).toBe('none');
    expect(parseCommand('   ', guests, nodes).kind).toBe('none');
  });

  it('plans power actions by name with the right CLI tool', () => {
    const r = parseCommand('start grafana', guests, nodes);
    expect(r.kind).toBe('command');
    if (r.kind !== 'command') return;
    expect(r.action).toBe('guest.start');
    expect(r.guest.vmid).toBe(131);
    expect(r.preview).toBe('pct start 131');
    const s = parseCommand('STOP web01', guests, nodes);
    expect(s.kind === 'command' && s.preview).toBe('qm stop 120');
  });

  it('refuses a VMID that exists in two clusters', () => {
    const r = parseCommand('stop 120', guests, nodes);
    expect(r.kind).toBe('error');
  });

  it('resolves unique prefixes and rejects ambiguous ones', () => {
    expect(parseCommand('reboot graf', guests, nodes).kind).toBe('command');
    const r = parseCommand('reboot web', guests, nodes);
    expect(r.kind === 'error' && r.message).toMatch(/ambiguous/);
  });

  it('never targets templates', () => {
    expect(parseCommand('start tpl', guests, nodes).kind).toBe('error');
  });

  it('validates migrate targets against the guest cluster', () => {
    const ok = parseCommand('migrate web01 pve3', guests, nodes);
    expect(ok.kind === 'command' && ok.preview).toBe('qm migrate 120 pve3 --online');
    expect(parseCommand('migrate web01 edge1', guests, nodes).kind).toBe('error');
    expect(parseCommand('migrate web01 pve1', guests, nodes).kind).toBe('error');
    expect(parseCommand('migrate web01', guests, nodes).kind).toBe('error');
    const ct = parseCommand('migrate grafana pve1', guests, nodes);
    // stopped CT: offline migration; a running CT would need --restart
    expect(ct.kind === 'command' && ct.preview).toBe('pct migrate 131 pve1');
    const live = parseCommand('migrate web02 pve3', guests, nodes);
    expect(live.kind === 'command' && live.preview).toBe('qm migrate 121 pve3 --online');
  });

  it('plans snapshots with a valid name', () => {
    const r = parseCommand('snapshot web02 pre-upgrade', guests, nodes);
    expect(r.kind === 'command' && r.preview).toBe('qm snapshot 121 pre-upgrade');
    expect(parseCommand('snapshot web02 9bad', guests, nodes).kind).toBe('error');
    const d = parseCommand('snapshot web02', guests, nodes);
    expect(d.kind === 'command' && d.params.name).toMatch(/^galley-\d{8}$/);
  });

  it('previews destroy like the backend: running guests are stopped first, disks purged', () => {
    const r = parseCommand('destroy edge-proxy', guests, nodes);
    expect(r.kind === 'command' && r.preview).toBe('pct stop 200 && pct destroy 200 --purge 1 --destroy-unreferenced-disks 1');
    const s = parseCommand('destroy grafana', guests, nodes);
    expect(s.kind === 'command' && s.preview).toBe('pct destroy 131 --purge 1 --destroy-unreferenced-disks 1');
  });

  it('rejects trailing junk for single-argument verbs', () => {
    expect(parseCommand('start web01 now', guests, nodes).kind).toBe('error');
  });
});
