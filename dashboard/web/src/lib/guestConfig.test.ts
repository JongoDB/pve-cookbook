import { describe, expect, it } from 'vitest';
import { describeDisk, describeNic, describePci, parseGuestConfig, parsePropString } from './guestConfig';

const GiB = 1024 ** 3;

describe('parsePropString', () => {
  it('splits key=value lists with a default key', () => {
    expect(parsePropString('local-zfs:vm-300-disk-0,iothread=1,size=200G')).toEqual({ _: 'local-zfs:vm-300-disk-0', iothread: '1', size: '200G' });
    expect(parsePropString(undefined)).toEqual({});
  });
});

describe('parseGuestConfig (qemu)', () => {
  const hw = parseGuestConfig('qemu', {
    cores: 16, sockets: 1, cpu: 'host', memory: '65536', balloon: 0, machine: 'q35', bios: 'ovmf', scsihw: 'virtio-scsi-single',
    scsi0: 'local-zfs:vm-300-disk-0,iothread=1,size=200G',
    virtio1: 'vm-pool:vm-300-disk-1,size=1T,backup=0',
    ide2: 'none,media=cdrom',
    efidisk0: 'local-zfs:vm-300-disk-2,efitype=4m,size=1M',
    net0: 'virtio=BC:24:11:AA:00:01,bridge=vmbr0,tag=20,firewall=1',
    net1: 'e1000=BC:24:11:AA:00:02,bridge=servers',
    hostpci0: 'mapping=gpu-a2-0,pcie=1',
    hostpci1: '0000:41:00.0,pcie=1,x-vga=1',
    boot: 'order=scsi0;net0', onboot: 1, name: 'llm-vllm', digest: 'abc',
  });

  it('reads CPU and memory', () => {
    expect(hw).toMatchObject({ cores: 16, sockets: 1, cpuType: 'host', memory: 64 * GiB, balloon: 'off', machine: 'q35', bios: 'ovmf' });
  });

  it('reads disks with storage, size and options, in bus order', () => {
    expect(hw.disks.map((d) => d.key)).toEqual(['efidisk0', 'ide2', 'scsi0', 'virtio1']);
    const scsi0 = hw.disks.find((d) => d.key === 'scsi0')!;
    expect(scsi0).toMatchObject({ bus: 'scsi', storage: 'local-zfs', volume: 'vm-300-disk-0', size: 200 * GiB, options: { iothread: '1' } });
    expect(describeDisk(scsi0)).toBe('local-zfs, 200 GiB, iothread');
    expect(describeDisk(hw.disks.find((d) => d.key === 'virtio1')!)).toBe('vm-pool, 1 TiB, not in backups');
    expect(describeDisk(hw.disks.find((d) => d.key === 'ide2')!)).toBe('CD/DVD, empty');
  });

  it('reads NICs: model, MAC, bridge, VLAN, firewall', () => {
    expect(hw.nets[0]).toMatchObject({ key: 'net0', model: 'virtio', mac: 'BC:24:11:AA:00:01', bridge: 'vmbr0', vlan: '20', firewall: true });
    expect(describeNic(hw.nets[0])).toBe('virtio, bridge vmbr0, VLAN 20, firewall on');
    expect(hw.nets[1]).toMatchObject({ model: 'e1000', bridge: 'servers', firewall: false });
  });

  it('reads PCI passthrough by mapping or host address', () => {
    expect(hw.hostpci).toEqual([
      { key: 'hostpci0', mapping: 'gpu-a2-0', pcie: true, primaryGpu: false, options: {} },
      { key: 'hostpci1', host: '0000:41:00.0', pcie: true, primaryGpu: true, options: {} },
    ]);
    expect(describePci(hw.hostpci[1])).toBe('host 0000:41:00.0, PCIe, primary GPU');
  });

  it('leaves the rest as options and hides internals', () => {
    expect(hw.options).toEqual([['boot', 'order=scsi0;net0'], ['name', 'llm-vllm'], ['onboot', '1']]);
  });
});

describe('parseGuestConfig (lxc)', () => {
  it('reads rootfs, mount points and veth NICs', () => {
    const hw = parseGuestConfig('lxc', {
      cores: 2, memory: 2048, swap: 512, hostname: 'grafana',
      rootfs: 'local-zfs:subvol-131-disk-0,size=8G',
      mp0: 'vm-pool:vm-131-disk-1,mp=/var/lib/grafana,size=20G,backup=1',
      net0: 'name=eth0,bridge=vmbr0,hwaddr=BC:24:11:00:00:31,ip=dhcp,type=veth',
    });
    expect(hw.disks.map((d) => [d.key, d.storage, d.size, d.mountpoint])).toEqual([
      ['mp0', 'vm-pool', 20 * GiB, '/var/lib/grafana'],
      ['rootfs', 'local-zfs', 8 * GiB, '/'],
    ]);
    expect(hw.nets[0]).toMatchObject({ name: 'eth0', model: 'veth', mac: 'BC:24:11:00:00:31', bridge: 'vmbr0', ip: 'dhcp' });
    expect(hw).toMatchObject({ memory: 2 * GiB, swap: 512 * 1024 ** 2, cpuType: 'host' });
    expect(hw.options).toEqual([['hostname', 'grafana']]);
  });
});
