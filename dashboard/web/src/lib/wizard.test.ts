import { describe, expect, it } from 'vitest';
import { callsCli, ctCalls, ctProblems, defaultCt, defaultCtGpu, defaultVm, llmPreset, vmCalls, vmProblems, withGpu, type VmSpec } from './wizard';

const base = (): VmSpec => ({ ...defaultVm('pve1'), vmid: '301', name: 'web03', disk: { ...defaultVm().disk, storage: 'vm-pool', sizeGiB: 40 } });

describe('VM wizard → calls', () => {
  it('builds one create call with q35, OVMF and an EFI disk by default', () => {
    const [c] = vmCalls({ ...base(), iso: 'cephfs:iso/debian-13.1.0-amd64-netinst.iso', start: true });
    expect(c.method).toBe('POST');
    expect(c.path).toBe('/nodes/pve1/qemu');
    expect(c.body).toEqual({
      vmid: '301', name: 'web03', ostype: 'l26', cores: '2', cpu: 'host', memory: '4096', machine: 'q35', bios: 'ovmf', scsihw: 'virtio-scsi-single', agent: '1',
      efidisk0: 'vm-pool:1,efitype=4m,pre-enrolled-keys=0',
      scsi0: 'vm-pool:40,iothread=1,discard=on,ssd=1',
      net0: 'virtio,bridge=vmbr0,firewall=1',
      ide2: 'cephfs:iso/debian-13.1.0-amd64-netinst.iso,media=cdrom',
      boot: 'order=scsi0;ide2;net0',
      start: '1',
    });
    // every value is a string (galley's api.call body is map[string]string)
    expect(Object.values(c.body).every((v) => typeof v === 'string')).toBe(true);
    expect(vmProblems({ ...base() })).toEqual([]);
  });

  it('a GPU forces q35 + OVMF, turns ballooning off and adds hostpci0 with pcie', () => {
    const s = withGpu({ ...base(), machine: 'pc', bios: 'seabios', cpuType: 'x86-64-v2-AES', balloonMiB: 1024 }, { mapping: 'gpu-a2-1' });
    const [c] = vmCalls(s);
    expect(c.body).toMatchObject({ machine: 'q35', bios: 'ovmf', balloon: '0', cpu: 'host', hostpci0: 'mapping=gpu-a2-1,pcie=1' });
    expect(c.body.efidisk0).toBeDefined();
    const raw = vmCalls(withGpu(base(), { host: '0000:16:00.0' }))[0];
    expect(raw.body.hostpci0).toBe('0000:16:00.0,pcie=1');
    expect(vmProblems({ ...s, machine: 'pc' })).toContain('GPU passthrough needs machine q35 and OVMF.');
  });

  it('a mapped GPU pins the VM with an HA resource and a strict node-affinity rule (on by default)', () => {
    const s = withGpu(base(), { mapping: 'gpu-a2-0', nodes: ['pve1', 'pve2'] });
    const calls = vmCalls(s);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['POST /nodes/pve1/qemu', 'POST /cluster/ha/resources', 'POST /cluster/ha/rules']);
    expect(calls[1].body).toEqual({ sid: 'vm:301', state: 'stopped' });
    expect(calls[2].body).toEqual({ rule: 'gpu-301', type: 'node-affinity', resources: 'vm:301', nodes: 'pve1,pve2', strict: '1', comment: 'galley: gpu-a2-0 only exists on these nodes' });
    // "start after it is created": HA starts it, no start= on the create call
    const started = vmCalls({ ...s, start: true }, ['gpu-301']);
    expect(started[0].body.start).toBeUndefined();
    expect(started[1].body.state).toBe('started');
    expect(started[2].body.rule).toBe('gpu-301-2');
    // option off, or a raw device: one call, start as before
    expect(vmCalls({ ...s, pinGpu: false, start: true })).toHaveLength(1);
    expect(vmCalls({ ...s, pinGpu: false, start: true })[0].body.start).toBe('1');
    expect(vmCalls(withGpu(base(), { host: '0000:16:00.0' }))).toHaveLength(1);
  });

  it('the LLM server preset: GPU, 16+ cores, 64 GiB, 200 GiB disk, cloud-init', () => {
    const s = llmPreset({ ...base(), name: '' }, { mapping: 'gpu-a2-0' });
    expect(s).toMatchObject({ name: 'llm-server', cores: 16, memoryMiB: 65536, balloonMiB: 0, machine: 'q35', bios: 'ovmf' });
    expect(s.disk.sizeGiB).toBe(200);
    expect(s.cloudInit.enabled).toBe(true);
    const [c] = vmCalls({ ...s, cloudInit: { ...s.cloudInit, user: 'debian', sshKeys: 'ssh-ed25519 AAAAC3Nza me@laptop' }, disk: { ...s.disk, importFrom: 'cephfs:import/debian-13-genericcloud-amd64.qcow2' } });
    expect(c.body).toMatchObject({
      cores: '16', memory: '65536', balloon: '0', hostpci0: 'mapping=gpu-a2-0,pcie=1', tags: 'gpu;ai',
      scsi0: 'vm-pool:0,import-from=cephfs:import/debian-13-genericcloud-amd64.qcow2,iothread=1,discard=on,ssd=1',
      ide2: 'vm-pool:cloudinit', ciuser: 'debian', ipconfig0: 'ip=dhcp', sshkeys: 'ssh-ed25519%20AAAAC3Nza%20me%40laptop',
    });
    // a bigger machine stays bigger
    expect(llmPreset({ ...base(), cores: 32, memoryMiB: 131072 }, null)).toMatchObject({ cores: 32, memoryMiB: 131072, gpu: null });
  });

  it('puts cloud-init on ide0 when an ISO is on ide2, and supports VLAN and static addresses', () => {
    const [c] = vmCalls({ ...base(), iso: 'cephfs:iso/x.iso', net: { bridge: 'vnet-ai', model: 'virtio', vlan: '40', firewall: false },
      cloudInit: { enabled: true, storage: '', user: '', sshKeys: '', ip: 'static', cidr: '192.0.2.50/24', gateway: '192.0.2.1' } });
    expect(c.body).toMatchObject({ ide0: 'vm-pool:cloudinit', ide2: 'cephfs:iso/x.iso,media=cdrom', net0: 'virtio,bridge=vnet-ai,tag=40', ipconfig0: 'ip=192.0.2.50/24,gw=192.0.2.1' });
  });

  it('reports what is missing', () => {
    expect(vmProblems({ ...defaultVm(''), net: { ...defaultVm().net, bridge: '' } })).toEqual(expect.arrayContaining([
      'Choose a node.', 'VMID must be a number from 100 to 999999999.', 'Choose a storage for the disk.', 'Choose a bridge or VNet.',
    ]));
  });

  it('previews the exact pvesh commands', () => {
    expect(callsCli(vmCalls(base()))).toMatch(/^pvesh create \/nodes\/pve1\/qemu --agent 1 --bios ovmf --boot 'order=scsi0;net0' --cores 2 /);
  });
});

describe('container GPU share', () => {
  const ct = () => ({ ...defaultCt('pve1'), vmid: '410', hostname: 'cuda01', template: 'local:vztmpl/x.tar.zst', rootfs: { storage: 'vm-pool', sizeGiB: 8 }, sshKeys: 'ssh-ed25519 AAAAC3Nza me@laptop' });
  it('NVIDIA (host driver): dev0..dev3 with the chosen GPU number', () => {
    const [c] = ctCalls({ ...ct(), gpu: { ...defaultCtGpu(), kind: 'nvidia', index: 1 } });
    expect(c.body).toMatchObject({ dev0: '/dev/nvidia1', dev1: '/dev/nvidiactl', dev2: '/dev/nvidia-uvm', dev3: '/dev/nvidia-uvm-tools' });
  });
  it('Intel/AMD: the render node, with an optional gid', () => {
    expect(ctCalls({ ...ct(), gpu: { ...defaultCtGpu(), kind: 'dri', gid: '104' } })[0].body.dev0).toBe('/dev/dri/renderD128,gid=104');
    expect(ctCalls(ct())[0].body.dev0).toBeUndefined();
    expect(ctProblems({ ...ct(), gpu: { ...defaultCtGpu(), kind: 'dri', dri: '/dev/sda', gid: 'x' } })).toEqual(['The render node must look like /dev/dri/renderD128.', 'The group id must be a number.']);
    expect(ctProblems({ ...ct(), gpu: { ...defaultCtGpu(), kind: 'nvidia', index: -1 } })).toEqual(['The NVIDIA GPU number must be 0 or more.']);
  });
});

describe('container wizard → calls', () => {
  const ct = () => ({ ...defaultCt('pve2'), vmid: '402', hostname: 'dns02', template: 'cephfs:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst', rootfs: { storage: 'vm-pool', sizeGiB: 8 }, sshKeys: 'ssh-ed25519 AAAAC3Nza me@laptop' });
  it('builds the create call with an SSH key and no password', () => {
    const [c] = ctCalls(ct());
    expect(c.path).toBe('/nodes/pve2/lxc');
    expect(c.body).toEqual({
      vmid: '402', hostname: 'dns02', ostemplate: 'cephfs:vztmpl/debian-13-standard_13.1-2_amd64.tar.zst', unprivileged: '1', features: 'nesting=1',
      cores: '1', memory: '1024', swap: '512', rootfs: 'vm-pool:8', net0: 'name=eth0,bridge=vmbr0,ip=dhcp,firewall=1',
      'ssh-public-keys': 'ssh-ed25519 AAAAC3Nza me@laptop', start: '1',
    });
    expect(c.body.password).toBeUndefined();
    expect(ctProblems(ct())).toEqual([]);
  });
  it('requires a public key and refuses private keys', () => {
    expect(ctProblems({ ...ct(), sshKeys: '' })).toContain('Add at least one SSH public key: galley does not set root passwords.');
    expect(ctProblems({ ...ct(), sshKeys: '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----' })).toContain('That is a private key. Paste the public key (.pub) only.');
  });
  it('static addressing with gateway and VLAN', () => {
    const [c] = ctCalls({ ...ct(), net: { bridge: 'vmbr0', vlan: '20', ip: 'static', cidr: '192.0.2.60/24', gateway: '192.0.2.1', firewall: false } });
    expect(c.body.net0).toBe('name=eth0,bridge=vmbr0,ip=192.0.2.60/24,gw=192.0.2.1,tag=20');
  });
});
