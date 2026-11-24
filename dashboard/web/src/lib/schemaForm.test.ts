import { describe, expect, it } from 'vitest';
import type { SchemaMethod } from '../api/types';
import {
  checkValue, diffBody, familyKeys, fillPath, joinProps, methodParams, nextFreeIndex, paramFor, pathVars, propFormat, pveshCli,
  splitProps, toFormValue, type PropFormat,
} from './schemaForm';

const PUT: SchemaMethod = {
  method: 'PUT',
  parameters: {
    type: 'object',
    properties: {
      node: { type: 'string' }, vmid: { type: 'integer' },
      cores: { type: 'integer', optional: 1, minimum: 1 }, name: { type: 'string', optional: 1 },
      onboot: { type: 'boolean', optional: 1 }, ostype: { type: 'string', optional: 1, enum: ['l26', 'win11'] },
      'net[n]': { type: 'string', optional: 1 }, 'hostpci[n]': { type: 'string', optional: 1 },
      digest: { type: 'string', optional: 1 }, delete: { type: 'string', optional: 1 },
    },
  },
};
const current = { name: 'web01', cores: '4', onboot: '1', net0: 'virtio,bridge=vmbr0', net1: 'virtio,bridge=vmbr1', hostpci0: 'mapping=gpu-a2-0,pcie=1', digest: 'beef' };

describe('methodParams', () => {
  it('drops path variables and control keys, separates indexed families', () => {
    const mp = methodParams(PUT, { node: 'pve1', vmid: '300' });
    expect(Object.keys(mp.plain).sort()).toEqual(['cores', 'name', 'onboot', 'ostype']);
    expect(Object.keys(mp.families).sort()).toEqual(['hostpci', 'net']);
    expect(mp.hasDigest && mp.hasDelete).toBe(true);
    expect(paramFor(mp, 'net7')).toBe(mp.families.net);
    expect(paramFor(mp, 'scsi0')).toBeUndefined();
  });
});

describe('indexed families', () => {
  it('lists members in numeric order and finds the next free index', () => {
    expect(familyKeys('net', ['net10', 'net2', 'name', 'net0', 'netx'])).toEqual(['net0', 'net2', 'net10']);
    expect(nextFreeIndex('net', Object.keys(current))).toBe(2);
    expect(nextFreeIndex('hostpci', Object.keys(current))).toBe(1);
    expect(nextFreeIndex('scsi', [])).toBe(0);
    expect(nextFreeIndex('ide', ['ide0', 'ide1', 'ide2', 'ide3'])).toBeNull();
  });
});

describe('diffBody', () => {
  it('sends only changed keys, plus the digest', () => {
    const body = diffBody({ initial: current, edits: { cores: '8', name: 'web01', onboot: '1' }, removed: [], mode: 'update' });
    expect(body).toEqual({ cores: '8', digest: 'beef' });
  });

  it('puts removed and cleared keys into delete, in key order', () => {
    const body = diffBody({ initial: current, edits: { name: '', net10: 'virtio,bridge=vmbr0' }, removed: ['net1', 'hostpci0'], mode: 'update' });
    expect(body).toEqual({ net10: 'virtio,bridge=vmbr0', delete: 'hostpci0,name,net1', digest: 'beef' });
  });

  it('adds a new family member without touching the others', () => {
    expect(diffBody({ initial: current, edits: { hostpci1: 'mapping=gpu-a2-1,pcie=1' }, removed: [], mode: 'update' }))
      .toEqual({ hostpci1: 'mapping=gpu-a2-1,pcie=1', digest: 'beef' });
  });

  it('sends nothing when nothing changed, and no digest when the schema lacks it', () => {
    expect(diffBody({ initial: current, edits: { cores: '4' }, removed: [], mode: 'update' })).toEqual({});
    expect(diffBody({ initial: current, edits: { cores: '2' }, removed: [], mode: 'update', hasDigest: false })).toEqual({ cores: '2' });
  });

  it('ignores removal of keys the resource never had (a new device added then removed)', () => {
    expect(diffBody({ initial: current, edits: { net2: 'virtio' }, removed: ['net2'], mode: 'update' })).toEqual({});
  });

  it('create mode sends every non-empty value and never delete or digest', () => {
    expect(diffBody({ initial: { digest: 'x' }, edits: { id: 'gpu-a2-1', map: 'node=pve1,path=0000:91:00.0', description: '' }, removed: [], mode: 'create' }))
      .toEqual({ id: 'gpu-a2-1', map: 'node=pve1,path=0000:91:00.0' });
  });
});

describe('values', () => {
  it('converts config values to form strings', () => {
    expect([toFormValue(true), toFormValue(false), toFormValue(4), toFormValue(undefined), toFormValue('x')]).toEqual(['1', '0', '4', '', 'x']);
  });
  it('checks types, ranges and enums', () => {
    const p = PUT.parameters!.properties!;
    expect(checkValue(p.cores, '0')).toBe('must be at least 1');
    expect(checkValue(p.cores, '2.5')).toBe('must be a whole number');
    expect(checkValue(p.cores, '')).toBeNull();
    expect(checkValue(p.onboot, 'yes')).toBe('must be yes or no');
    expect(checkValue(p.ostype, 'win98')).toContain('must be one of');
    expect(checkValue(p.ostype, 'l26')).toBeNull();
  });
});

describe('property strings', () => {
  const fmt: PropFormat = {
    model: { type: 'string', enum: ['virtio', 'e1000'], default_key: 1 }, macaddr: { type: 'string' }, bridge: { type: 'string' }, tag: { type: 'integer' },
  };
  it('splits and joins by the format, default key first', () => {
    expect(splitProps('virtio,bridge=vmbr0,tag=20', fmt)).toEqual({ model: 'virtio', bridge: 'vmbr0', tag: '20' });
    expect(joinProps({ tag: '30', model: 'virtio', bridge: 'vmbr1' }, fmt)).toBe('virtio,bridge=vmbr1,tag=30');
  });
  it('understands the legacy qemu NIC form and gives up on unknown keys', () => {
    expect(splitProps('virtio=BC:24:11:00:01:2C,bridge=vmbr0', fmt)).toEqual({ model: 'virtio', macaddr: 'BC:24:11:00:01:2C', bridge: 'vmbr0' });
    expect(splitProps('virtio,queues=4', fmt)).toBeNull();
  });
  it('finds the format only when PVE describes one', () => {
    expect(propFormat({ format: fmt })).toBe(fmt);
    expect(propFormat({ format: 'pve-vmid' })).toBeNull();
  });
});

describe('paths and pvesh', () => {
  it('fills template paths only when every variable is safe', () => {
    expect(pathVars('/nodes/{node}/qemu/{vmid}/config')).toEqual(['node', 'vmid']);
    expect(fillPath('/nodes/{node}/qemu/{vmid}/config', { node: 'pve1', vmid: '300' })).toBe('/nodes/pve1/qemu/300/config');
    expect(fillPath('/nodes/{node}/qemu', {})).toBeNull();
    expect(fillPath('/nodes/{node}/qemu', { node: '../etc' })).toBeNull();
  });
  it('matches the backend CLI text: sorted keys, quoting, redacted secrets', () => {
    expect(pveshCli('PUT', '/nodes/pve1/qemu/300/config', { hostpci1: 'mapping=gpu-a2-1,pcie=1', description: "it's new", cipassword: 'hunter2' }))
      .toBe("pvesh set /nodes/pve1/qemu/300/config --cipassword '<redacted>' --description 'it'\\''s new' --hostpci1 mapping=gpu-a2-1,pcie=1");
    expect(pveshCli('POST', '/cluster/mapping/pci', {})).toBe('pvesh create /cluster/mapping/pci');
  });
});
