---
id: admin/guests-vms-lxc
title: Create VMs and containers (incl. cloud-init templates)
tested: "PVE 9.2 · Ceph 19.2 · 3-node HCI · 2026-11 (LXC path); cloud-init path untested"
risk: low
runs_on: node
---

# Create VMs and containers

Quick, repeatable guest creation from the CLI: LXC from a template, and VMs cloned from a
cloud-init template built from an upstream cloud image. For one-click apps use
[helper-scripts](helper-scripts.md) instead.

## Preconditions

- Target storage active: `pvesm status | grep -E '^(vm-pool|local-zfs) .*active'`
- Target vnet applied on the node: `ip link show servers`
- A free VMID: `pvesh get /cluster/nextid`

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `ID` | VMID (100–999999999) | `110` |
| `STORAGE` | Disk storage | `vm-pool` (shared, HA-capable) or `local-zfs` (node-local, fastest) |
| `VNET` | Network | `servers` |
| `IP` / `GW` | Static address and gateway | `10.10.10.20/24` / `10.10.10.1` |
| `SSHKEY` | Public key file | `~/.ssh/id_ed25519.pub` |

**Placement rule:** anything that must survive a node failure goes on `vm-pool` (Ceph). Use
`local-zfs` for scratch, CI runners, or when you replicate with `pvesr` yourself.

## Steps

### LXC container

```bash
pveam update
pveam available --section system | grep -E 'debian-13-standard.*amd64'
pveam download cephfs debian-13-standard_13.6-1_amd64.tar.zst      # once per cluster (shared store)

pct create 110 cephfs:vztmpl/debian-13-standard_13.6-1_amd64.tar.zst \
  --hostname web01 --unprivileged 1 --features nesting=1 \
  --cores 2 --memory 2048 --swap 512 \
  --rootfs vm-pool:8 \
  --net0 name=eth0,bridge=servers,ip=10.10.10.20/24,gw=10.10.10.1 \
  --nameserver 1.1.1.1 --searchdomain example.internal \
  --ssh-public-keys ~/.ssh/id_ed25519.pub \
  --tags web,prod --onboot 1 --start 1
```

### Cloud-init VM template (build once)

```bash
cd /tmp && wget -q https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2
qm create 9000 --name tmpl-debian13 --ostype l26 --machine q35 --bios ovmf \
  --cpu host --cores 2 --memory 2048 --agent enabled=1 \
  --net0 virtio,bridge=servers --scsihw virtio-scsi-single \
  --efidisk0 vm-pool:1,efitype=4m,pre-enrolled-keys=0
qm disk import 9000 debian-13-genericcloud-amd64.qcow2 vm-pool
qm set 9000 --scsi0 vm-pool:vm-9000-disk-1,discard=on,iothread=1,ssd=1 --boot order=scsi0 \
  --ide2 vm-pool:cloudinit --serial0 socket --vga serial0
qm template 9000
```

Check the imported disk name with `qm config 9000 | grep unused` before the `--scsi0` line; it is
attached as `unused0` first.

### Clone a VM from the template

```bash
qm clone 9000 120 --name app01 --full 1 --storage vm-pool
qm set 120 --cores 4 --memory 8192 \
  --ipconfig0 ip=10.10.10.30/24,gw=10.10.10.1 --nameserver 1.1.1.1 \
  --ciuser ops --sshkeys ~/.ssh/id_ed25519.pub --tags app,prod --onboot 1
qm disk resize 120 scsi0 +30G
qm start 120
```

### Make it highly available (shared storage only)

```bash
ha-manager add vm:120 --state started --max_restart 2 --max_relocate 2
```

## Verify

```bash
pct status 110 && pct exec 110 -- ping -c1 -W2 10.10.10.1
qm status 120 && qm agent 120 ping && qm guest cmd 120 network-get-interfaces | grep -m2 ip-address
ha-manager status | grep -E 'vm:120'
```

## Rollback

```bash
pct stop 110 && pct destroy 110 --purge 1
ha-manager remove vm:120; qm stop 120 && qm destroy 120 --purge 1 --destroy-unreferenced-disks 1
```

## Gotchas

- `--purge 1` also removes the guest from backup jobs, HA and replication configs.
- Containers on ZFS need the `vmdata` dataset to have a mountpoint; `mountpoint=none` breaks `pct create` on `local-zfs`.
- If `pct create` on Ceph RBD fails in `mkfs.ext4` with "does not exist and no size was specified", a stray initramfs udevd is running; see `scripts/pve-health.sh` check `udev`.
- vnet MTU is 1450 on EVPN; cloud images usually pick it up via DHCP/cloud-init. Set `mtu=1450` on the NIC if traffic stalls on large packets.
- `qm disk import` replaced `qm importdisk` (the old name still works as an alias).
