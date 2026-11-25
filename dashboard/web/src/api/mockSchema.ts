// A slice of PVE's API schema (apidoc.js shape) for mock mode: enough paths to drive the
// resource editor, the API explorer and the create wizards. Descriptions follow PVE's wording.
import type { SchemaMethod, SchemaParam } from './types';

type P = SchemaParam & { default_key?: number };
const opt = (p: P): P => ({ ...p, optional: 1 });
const str = (description: string, extra: P = {}): P => opt({ type: 'string', description, ...extra });
const int = (description: string, minimum?: number, maximum?: number, extra: P = {}): P =>
  opt({ type: 'integer', description, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}), ...extra });
const bool = (description: string, dflt?: number): P => opt({ type: 'boolean', description, ...(dflt !== undefined ? { default: dflt } : {}) });
const en = (description: string, values: string[], dflt?: string): P => opt({ type: 'string', enum: values, description, ...(dflt ? { default: dflt } : {}) });

const node: P = { type: 'string', description: 'The cluster node name.', format: 'pve-node' };
const vmid: P = { type: 'integer', description: 'The (unique) ID of the VM.', minimum: 100, maximum: 999999999, format: 'pve-vmid' };
const digest = str('Prevent changes if current configuration file has a different digest. This can be used to prevent concurrent modifications.', { maxLength: 64 });
const del = str('A list of settings you want to delete.', { format: 'pve-configid-list' });

const netFormat: Record<string, P> = {
  model: { type: 'string', enum: ['e1000', 'e1000e', 'rtl8139', 'virtio', 'vmxnet3'], description: 'Network Card Model.', default_key: 1 },
  macaddr: str('MAC address. That address must be unique within your network.'),
  bridge: str('Bridge to attach the network device to.'),
  tag: int('VLAN tag to apply to packets on this interface.', 1, 4094),
  firewall: bool('Whether this interface should be protected by the firewall.'),
  link_down: bool('Whether this interface should be disconnected (like pulling the plug).'),
  mtu: int('Force MTU of network device, for VirtIO only. Set to 1 to use the bridge MTU.', 1, 65520),
  queues: int('Number of packet queues to be used on the device.', 0, 64),
  rate: opt({ type: 'number', minimum: 0, description: 'Rate limit in mbps (megabytes per second) as floating point number.' }),
};
const diskFormat: Record<string, P> = {
  file: { type: 'string', description: 'The drive\'s backing volume.', default_key: 1 },
  size: str('Disk size. This is purely informational and has no effect.'),
  iothread: bool('Whether to use iothreads for this drive.'),
  discard: en('Controls whether to pass discard/trim requests to the underlying storage.', ['ignore', 'on']),
  ssd: bool('Whether to expose this drive as an SSD, rather than a rotational hard disk.'),
  cache: en('The drive\'s cache mode.', ['none', 'writethrough', 'writeback', 'unsafe', 'directsync']),
  backup: bool('Whether the drive should be included when making backups.'),
  replicate: bool('Whether the drive should be considered for replication jobs.', 1),
  media: en('The drive\'s media type.', ['cdrom', 'disk'], 'disk'),
};
const pciFormat: Record<string, P> = {
  host: { type: 'string', description: 'Host PCI device pass through. The PCI ID of a host\'s PCI device or a list of PCI virtual functions of the host.', default_key: 1 },
  mapping: str('The ID of a cluster wide mapping. Either this or the default-key \'host\' must be set.'),
  pcie: bool('Choose the PCI-express bus (needs the \'q35\' machine model).'),
  'x-vga': bool('Enable vfio-vga device support.'),
  rombar: bool('Specify whether or not the device\'s ROM will be visible in the guest\'s memory map.', 1),
};
const lxcNetFormat: Record<string, P> = {
  name: { type: 'string', description: 'Name of the network device as seen from inside the container. (lxc.network.name)' },
  bridge: str('Bridge to attach the network device to.'),
  hwaddr: str('A common MAC address with the I/G (Individual/Group) bit not set.'),
  ip: str('IPv4 address in CIDR format, or dhcp or manual.'),
  gw: str('Default gateway for IPv4 traffic.'),
  ip6: str('IPv6 address in CIDR format, or auto, dhcp or manual.'),
  tag: int('VLAN tag for this interface.', 1, 4094),
  firewall: bool('Controls whether this interface\'s firewall rules should be used.'),
  type: en('Network interface type.', ['veth'], 'veth'),
  rate: opt({ type: 'number', minimum: 0, description: 'Apply rate limiting to the interface' }),
};

const ostypes = ['other', 'wxp', 'w2k', 'w2k3', 'w2k8', 'wvista', 'win7', 'win8', 'win10', 'win11', 'l24', 'l26', 'solaris'];

/** Parameters shared by VM create (POST /nodes/{node}/qemu) and config (PUT …/config). */
function qemuOptions(): Record<string, P> {
  return {
    name: str('Set a name for the VM. Only used on the configuration web interface.', { format: 'dns-name' }),
    description: str('Description for the VM. Shown in the web-interface VM\'s summary.', { maxLength: 8192 }),
    tags: str('Tags of the VM. This is only meta information.'),
    ostype: en('Specify guest operating system.', ostypes),
    cores: int('The number of cores per socket.', 1, undefined, { default: 1 }),
    sockets: int('The number of CPU sockets.', 1, undefined, { default: 1 }),
    cpu: str('Emulated CPU type.', { typetext: '[[cputype=]<string>] [,flags=<+FLAG[;-FLAG...]>]', default: 'kvm64' }),
    vcpus: int('Number of hotplugged vcpus.', 1),
    numa: bool('Enable/disable NUMA.', 0),
    memory: str('Memory properties.', { typetext: '[current=]<integer>', default: '2048' }),
    balloon: int('Amount of target RAM for the VM in MiB. Using zero disables the ballon driver.', 0),
    machine: str('Specify the QEMU machine.', { typetext: '[[type=]<machine type>] [,viommu=<intel|virtio>]' }),
    bios: en('Select BIOS implementation.', ['seabios', 'ovmf'], 'seabios'),
    scsihw: en('SCSI controller model', ['lsi', 'lsi53c810', 'virtio-scsi-pci', 'virtio-scsi-single', 'megasas', 'pvscsi'], 'lsi'),
    agent: str('Enable/disable communication with the QEMU Guest Agent and its properties.', { typetext: '[enabled=]<1|0> [,fstrim_cloned_disks=<1|0>]' }),
    boot: str('Specify guest boot order.', { typetext: '[[legacy=]<[acdn]{1,4}>] [,order=<device[;device...]>]' }),
    onboot: bool('Specifies whether a VM will be started during system bootup.', 0),
    protection: bool('Sets the protection flag of the VM. This will disable the remove VM and remove disk operations.', 0),
    startup: str('Startup and shutdown behavior. Order is a non-negative number defining the general startup order.', { typetext: '[[order=]\\d+] [,up=\\d+] [,down=\\d+]' }),
    hotplug: str('Selectively enable hotplug features.', { default: 'network,disk,usb' }),
    efidisk0: str('Configure a disk for storing EFI vars.', { typetext: '[file=]<volume> [,efitype=<2m|4m>] [,pre-enrolled-keys=<1|0>] [,size=<DiskSize>]' }),
    ciuser: str('cloud-init: User name to change ssh keys and password for instead of the image\'s configured default user.'),
    sshkeys: str('cloud-init: Setup public SSH keys (one key per line, OpenSSH format).'),
    'net[n]': opt({ type: 'string', description: 'Specify network devices.', format: netFormat, typetext: '[model=]<enum> [,bridge=<bridge>] [,firewall=<1|0>] [,tag=<integer>] ...' }),
    'scsi[n]': opt({ type: 'string', description: 'Use volume as SCSI hard disk or CD-ROM (n is 0 to 30). Use the special syntax STORAGE_ID:SIZE_IN_GiB to allocate a new volume.', format: diskFormat, typetext: '[file=]<volume> [,iothread=<1|0>] [,discard=<ignore|on>] [,ssd=<1|0>] ...' }),
    'virtio[n]': opt({ type: 'string', description: 'Use volume as VIRTIO hard disk (n is 0 to 15).', format: diskFormat }),
    'sata[n]': opt({ type: 'string', description: 'Use volume as SATA hard disk or CD-ROM (n is 0 to 5).', format: diskFormat }),
    'ide[n]': opt({ type: 'string', description: 'Use volume as IDE hard disk or CD-ROM (n is 0 to 3).', format: diskFormat }),
    'hostpci[n]': opt({ type: 'string', description: 'Map host PCI devices into guest.', format: pciFormat, typetext: '[[host=]<HOSTPCIID[;HOSTPCIID2...]>] [,mapping=<mapping-id>] [,pcie=<1|0>] [,x-vga=<1|0>] ...' }),
    'ipconfig[n]': opt({ type: 'string', description: 'cloud-init: Specify IP addresses and gateways for the corresponding interface.', typetext: '[gw=<GatewayIPv4>] [,ip=<IPv4Format/CIDR>]' }),
    'unused[n]': opt({ type: 'string', description: 'Reference to unused volumes. This is used internally, and should not be modified manually.' }),
  };
}

function lxcOptions(): Record<string, P> {
  return {
    hostname: str('Set a host name for the container.', { format: 'dns-name' }),
    description: str('Description for the Container.', { maxLength: 8192 }),
    tags: str('Tags of the Container. This is only meta information.'),
    cores: int('The number of cores assigned to the container.', 1, 8192),
    cpulimit: opt({ type: 'number', minimum: 0, maximum: 8192, default: 0, description: 'Limit of CPU usage. 0 indicates no CPU limit.' }),
    memory: int('Amount of RAM for the container in MB.', 16, undefined, { default: 512 }),
    swap: int('Amount of SWAP for the container in MB.', 0, undefined, { default: 512 }),
    onboot: bool('Specifies whether a container will be started during system bootup.', 0),
    protection: bool('Sets the protection flag of the container. This will prevent the CT or CT\'s disk remove/update operation.', 0),
    features: str('Allow containers access to advanced features.', { typetext: '[fuse=<1|0>] [,keyctl=<1|0>] [,mount=<fstype;fstype;...>] [,nesting=<1|0>]' }),
    rootfs: str('Use volume as container root.', { typetext: '[volume=]<volume> [,size=<DiskSize>] ...' }),
    'net[n]': opt({ type: 'string', description: 'Specifies network interfaces for the container.', format: lxcNetFormat, typetext: 'name=<string> [,bridge=<bridge>] [,ip=<(IPv4/CIDR|dhcp|manual)>] ...' }),
    'mp[n]': opt({ type: 'string', description: 'Use volume as container mount point. Use the special syntax STORAGE_ID:SIZE_IN_GiB to allocate a new volume.', typetext: '[volume=]<volume> ,mp=<Path> [,backup=<1|0>] [,size=<DiskSize>] ...' }),
    'dev[n]': opt({ type: 'string', description: 'Device to pass through to the container', typetext: '[[path=]<Path>] [,gid=<integer>] [,mode=<Octal access mode>] [,uid=<integer>]' }),
  };
}

const perm = (check: unknown[], description?: string) => ({ check, ...(description ? { description } : {}) });
const m = (method: string, name: string, description: string, properties: Record<string, P>, permissions?: Record<string, unknown>, returns: P = { type: 'null' }): SchemaMethod =>
  ({ method, name, description, permissions, parameters: { type: 'object', properties }, returns });

export interface MockSchemaNode { path: string; text: string; info: Record<string, SchemaMethod> }

export function mockSchema(): MockSchemaNode[] {
  const vmAlloc = perm(['perm', '/vms/{vmid}', ['VM.Allocate']], 'You need \'VM.Allocate\' permissions on /vms/{vmid} or on the VM pool /pool/{pool}. For restore, it is enough if the user has \'VM.Backup\' permission and the VM already exists.');
  const vmConfig = perm(['perm', '/vms/{vmid}', ['VM.Config.Disk', 'VM.Config.CPU', 'VM.Config.Memory', 'VM.Config.Network', 'VM.Config.Options', 'VM.Config.HWType'], 'any', 1], 'You need \'VM.Config.*\' permissions on /vms/{vmid}, depending on which settings you change.');
  return [
    {
      path: '/nodes/{node}/qemu', text: 'qemu', info: {
        GET: m('GET', 'vmlist', 'Virtual machine index (per node).', { node, full: bool('Determine the full status of active VMs.') }, perm(['perm', '/vms/{vmid}', ['VM.Audit']], 'Only list VMs where you have VM.Audit permissons on /vms/<vmid>.'), { type: 'array' }),
        POST: m('POST', 'create_vm', 'Create or restore a virtual machine.', {
          node, vmid, ...qemuOptions(),
          start: bool('Start VM after it was created successfully.', 0),
          pool: str('Add the VM to the specified pool.'),
          storage: str('Default storage.', { format: 'pve-storage-id' }),
        }, vmAlloc, { type: 'string', description: 'UPID' }),
      },
    },
    {
      path: '/nodes/{node}/qemu/{vmid}', text: '{vmid}', info: {
        GET: m('GET', 'vmdiridx', 'Directory index', { node, vmid }, perm(['perm', '/vms/{vmid}', ['VM.Audit']]), { type: 'array' }),
        DELETE: m('DELETE', 'destroy_vm', 'Destroy the VM and all used/owned volumes. Removes any VM specific permissions and firewall rules', {
          node, vmid, purge: bool('Remove VMID from configurations, like backup & replication jobs and HA.'),
          'destroy-unreferenced-disks': bool('If set, destroy additionally all disks not referenced in the config but with a matching VMID from all enabled storages.', 1),
        }, perm(['perm', '/vms/{vmid}', ['VM.Allocate']]), { type: 'string' }),
      },
    },
    {
      path: '/nodes/{node}/qemu/{vmid}/config', text: 'config', info: {
        GET: m('GET', 'vm_config', 'Get the virtual machine configuration with pending configuration changes applied.', { node, vmid, current: bool('Get current values (instead of pending values).', 0) }, perm(['perm', '/vms/{vmid}', ['VM.Audit']]), { type: 'object' }),
        PUT: m('PUT', 'update_vm', 'Set virtual machine options (synchrounous API) - You should consider using the POST method instead for any actions involving hotplug or storage allocation.', {
          node, vmid, ...qemuOptions(), digest, delete: del, revert: str('Revert a pending change.'),
          skiplock: bool('Ignore locks - only root is allowed to use this option.'),
        }, vmConfig),
        POST: m('POST', 'update_vm_async', 'Set virtual machine options (asynchrounous API).', { node, vmid, ...qemuOptions(), digest, delete: del }, vmConfig, { type: 'string' }),
      },
    },
    {
      path: '/nodes/{node}/qemu/{vmid}/status/start', text: 'start', info: {
        POST: m('POST', 'vm_start', 'Start virtual machine.', { node, vmid, timeout: int('Wait maximal timeout seconds.', 0, 86400) }, perm(['perm', '/vms/{vmid}', ['VM.PowerMgmt']]), { type: 'string' }),
      },
    },
    {
      path: '/nodes/{node}/qemu/{vmid}/status/stop', text: 'stop', info: {
        POST: m('POST', 'vm_stop', 'Stop virtual machine. The qemu process will exit immediately. This is akin to pulling the power plug of a running computer and may damage the VM data.', { node, vmid, timeout: int('Wait maximal timeout seconds.', 0) }, perm(['perm', '/vms/{vmid}', ['VM.PowerMgmt']]), { type: 'string' }),
      },
    },
    {
      path: '/nodes/{node}/lxc', text: 'lxc', info: {
        GET: m('GET', 'vmlist', 'LXC container index (per node).', { node }, perm(['perm', '/vms/{vmid}', ['VM.Audit']]), { type: 'array' }),
        POST: m('POST', 'create_vm', 'Create or restore a container.', {
          node, vmid, ...lxcOptions(),
          ostemplate: { type: 'string', description: 'The OS template or backup file.', maxLength: 255 },
          unprivileged: bool('Makes the container run as unprivileged user. (Should not be modified manually.)', 0),
          'ssh-public-keys': str('Setup public SSH keys (one key per line, OpenSSH format).'),
          password: str('Sets root password inside container.'),
          start: bool('Start the CT after its creation finished successfully.', 0),
          storage: str('Default Storage.', { default: 'local' }),
          pool: str('Add the VM to the specified pool.'),
        }, vmAlloc, { type: 'string' }),
      },
    },
    {
      path: '/nodes/{node}/lxc/{vmid}/config', text: 'config', info: {
        GET: m('GET', 'vm_config', 'Get container configuration.', { node, vmid }, perm(['perm', '/vms/{vmid}', ['VM.Audit']]), { type: 'object' }),
        PUT: m('PUT', 'update_vm', 'Set container options.', { node, vmid, ...lxcOptions(), digest, delete: del }, vmConfig),
      },
    },
    { path: '/cluster/nextid', text: 'nextid', info: { GET: m('GET', 'nextid', 'Get next free VMID. Pass a VMID to assert that its free (at time of check).', { vmid: { ...vmid, optional: 1 } }, perm([], 'Accessible by all authenticated users.'), { type: 'integer' }) } },
    {
      path: '/nodes/{node}/storage', text: 'storage', info: {
        GET: m('GET', 'index', 'Get status for all datastores.', {
          node, content: str('Only list stores which support this content type.', { format: 'pve-storage-content-list' }),
          enabled: bool('Only list stores which are enabled (not disabled in config).', 0),
          storage: str('Only list status for  specified storage', { format: 'pve-storage-id' }),
        }, perm([], 'Only list entries where you have \'Datastore.Audit\' or \'Datastore.AllocateSpace\' permissions on \'/storage/<storage>\''), { type: 'array' }),
      },
    },
    {
      path: '/nodes/{node}/storage/{storage}/content', text: 'content', info: {
        GET: m('GET', 'index', 'List storage content.', { node, storage: { type: 'string', format: 'pve-storage-id', description: 'The storage identifier.' }, content: str('Only list content of this type.'), vmid: { ...vmid, optional: 1 } }, perm(['perm', '/storage/{storage}', ['Datastore.Audit', 'Datastore.AllocateSpace'], 'any', 1]), { type: 'array' }),
      },
    },
    {
      path: '/nodes/{node}/network', text: 'network', info: {
        GET: m('GET', 'index', 'List available networks', { node, type: en('Only list specific interface types.', ['bridge', 'bond', 'eth', 'alias', 'vlan', 'OVSBridge', 'OVSBond', 'OVSPort', 'OVSIntPort', 'vnet', 'any_bridge', 'any_local_bridge', 'include_sdn']) }, perm([], 'Accessible by all authenticated users.'), { type: 'array' }),
      },
    },
    {
      path: '/cluster/sdn/vnets', text: 'vnets', info: {
        GET: m('GET', 'index', 'SDN vnets index.', { pending: bool('Display pending config.'), running: bool('Display running config.') }, perm([], 'Require \'SDN.Audit\' or \'SDN.Allocate\' permissions on \'/sdn/zones/<zone>/<vnet>\''), { type: 'array' }),
        POST: m('POST', 'create', 'Create a new sdn vnet object.', { vnet: { type: 'string', description: 'The SDN vnet object identifier.' }, zone: { type: 'string', description: 'zone id' }, tag: int('VLAN Tag (for VLAN or QinQ zones) or VXLAN VNI (for VXLAN or EVPN zones).', 1, 16777215), alias: str('Alias name of the VNet.', { maxLength: 256 }), vlanaware: bool('Allow VLANs to pass through this vnet.') }, perm(['perm', '/sdn/zones/{zone}', ['SDN.Allocate']])),
      },
    },
    {
      path: '/nodes/{node}/hardware/pci', text: 'pci', info: {
        GET: m('GET', 'pciscan', 'List local PCI devices.', { node, 'pci-class-blacklist': str('A list of blacklisted PCI classes, which will not be returned. Following are filtered by default: Memory Controller (05), Bridge (06) and Processor (0b).', { default: '05;06;0b' }), verbose: bool('If disabled, does only print the PCI IDs. Otherwise, additional information like vendor and device will be returned.', 1) }, perm(['perm', '/', ['Sys.Audit', 'Sys.Modify'], 'any', 1]), { type: 'array' }),
      },
    },
    {
      path: '/cluster/mapping/pci', text: 'pci', info: {
        GET: m('GET', 'index', 'List PCI Hardware Mapping', { 'check-node': str('If given, checks the configurations on the given node for correctness, and adds relevant diagnostics for the devices to the response.') }, perm([], 'Only lists entries where you have \'Mapping.Modify\', \'Mapping.Use\' or \'Mapping.Audit\' permissions on \'/mapping/pci/<id>\'.'), { type: 'array' }),
        POST: m('POST', 'create', 'Create a new hardware mapping.', {
          id: { type: 'string', description: 'The ID of the logical PCI mapping.', format: 'pve-configid' },
          map: { type: 'array', description: 'A list of maps for the cluster nodes.', items: { type: 'string', format: 'pve-pci-hardware-map', typetext: '[node=]<node> [,id=<vendor:device>] [,iommugroup=<integer>] [,path=<pathid>] [,subsystem-id=<vendor:device>]' } as P, typetext: 'node=<node>,path=<0000:16:00.0>,id=<10de:25b6>,iommugroup=<n>' },
          description: str('Description of the logical PCI device.', { maxLength: 4096 }),
          mdev: bool('Marks the device(s) as being capable of providing mediated devices.'),
          'live-migration-capable': bool('Marks the device(s) as being able to be live-migrated (Experimental). This needs hardware and driver support to work.'),
        }, perm(['perm', '/mapping/pci', ['Mapping.Modify']])),
      },
    },
    {
      path: '/cluster/backup', text: 'backup', info: {
        GET: m('GET', 'index', 'List vzdump backup schedule.', {}, perm(['perm', '/', ['Sys.Audit']]), { type: 'array' }),
      },
    },
    {
      path: '/cluster/ha/resources', text: 'resources', info: {
        GET: m('GET', 'index', 'List HA resources.', { type: en('Only list resources of specific type', ['ct', 'vm']) }, perm(['perm', '/', ['Sys.Audit']]), { type: 'array' }),
        POST: m('POST', 'create', 'Create a new HA resource.', {
          sid: { type: 'string', description: 'HA resource ID. This consists of a resource type followed by a resource specific name, separated with colon (example: vm:100 / ct:100).' },
          state: en('Requested resource state.', ['started', 'stopped', 'enabled', 'disabled', 'ignored'], 'started'),
          max_restart: int('Maximal number of tries to restart the service on a node after its start failed.', 0, undefined, { default: 1 }),
          max_relocate: int('Maximal number of service relocate tries when a service failes to start.', 0, undefined, { default: 1 }),
          comment: str('Description.', { maxLength: 4096 }),
        }, perm(['perm', '/', ['Sys.Console']])),
      },
    },
    {
      // PVE 9 describes POST with allOf + oneOf on "type" (see internal/schema); the mock lists the union.
      path: '/cluster/ha/rules', text: 'rules', info: {
        GET: m('GET', 'index', 'Get HA rules.', { type: en('Limit the returned list to the specified rule type.', ['node-affinity', 'resource-affinity']), resource: str('Limit the returned list to rules affecting the specified resource.') }, perm(['perm', '/', ['Sys.Audit']]), { type: 'array' }),
        POST: m('POST', 'create_rule', 'Create HA rule.', {
          rule: { type: 'string', description: 'HA rule identifier.', format: 'pve-configid' },
          type: { type: 'string', enum: ['node-affinity', 'resource-affinity'], description: 'HA rule type.' },
          resources: { type: 'string', description: 'List of HA resource IDs. This consists of a list of resource types followed by a resource specific name separated with a colon (example: vm:100,ct:101).', format: 'pve-ha-resource-id-list' },
          nodes: str('List of cluster node names with optional priority. (node-affinity)', { format: 'pve-ha-node-list' }),
          strict: bool('Describes whether the node affinity rule is strict or non-strict. (node-affinity)', 0),
          affinity: en('Describes whether the HA resources are supposed to be kept on the same node (\'positive\'), or are supposed to be kept on separate nodes (\'negative\'). (resource-affinity)', ['positive', 'negative']),
          comment: str('HA rule description.', { maxLength: 4096 }),
          disable: bool('Whether the HA rule is disabled.', 0),
        }, perm(['perm', '/', ['Sys.Console']])),
      },
    },
    { path: '/access/users', text: 'users', info: { GET: m('GET', 'index', 'User index.', { enabled: bool('Optional filter for enable property.'), full: bool('Include group and token information.', 0) }, perm([], 'The returned list is restricted to users where you have \'User.Modify\' or \'Sys.Audit\' permissions on \'/access/groups\' or on a group the user belongs too.'), { type: 'array' }) } },
    { path: '/version', text: 'version', info: { GET: m('GET', 'version', 'API version details, including some parts of the global datacenter config.', {}, perm([], 'Accessible by all authenticated users.'), { type: 'object' }) } },
  ];
}

/** Match a concrete path to a schema node (literal segments win over {vars}), like internal/schema.Match. */
export function matchSchema(nodes: MockSchemaNode[], path: string): { node: MockSchemaNode; vars: Record<string, string> } | null {
  const segs = path.replace(/^\/+|\/+$/g, '').split('/');
  let best: { node: MockSchemaNode; vars: Record<string, string>; lit: number } | null = null;
  for (const n of nodes) {
    const ts = n.path.replace(/^\/+/, '').split('/');
    if (ts.length !== segs.length) continue;
    const vars: Record<string, string> = {};
    let lit = 0;
    let ok = true;
    ts.forEach((t, i) => {
      if (!ok) return;
      if (t.startsWith('{')) { if (!segs[i]) ok = false; else vars[t.slice(1, -1)] = segs[i]; } else if (t === segs[i]) lit++; else ok = false;
    });
    if (ok && (!best || lit > best.lit)) best = { node: n, vars, lit };
  }
  return best ? { node: best.node, vars: best.vars } : null;
}
