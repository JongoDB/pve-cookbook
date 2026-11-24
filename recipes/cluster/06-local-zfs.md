---
id: cluster/06-local-zfs
title: Node-local ZFS — fast local tier and off-Ceph backup target
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: high
runs_on: operator
automated_by: scripts/pvecb --yes local-zfs
---

# Node-local ZFS — fast local tier and off-Ceph backup target

Turn one spare fast disk per node into a ZFS pool with the same name on every node.
Two storages sit on it:

- `local-zfs`: local VM and CT disks. Because the name matches on every node, it
  supports ZFS storage replication.
- `backup-local`: a node-local vzdump target that lives outside Ceph.

The step also stops guests landing on the boot disk by disabling `local-lvm`.

## Preconditions

- One unused disk per node, selected by `storage.local_zfs.model_match` (or `nodes[].zfs_device`).
- Cluster quorate (storage definitions are cluster-wide).

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `storage.local_zfs.model_match` | Disk model substring | `800GB` |
| `nodes[].zfs_device` | Explicit disk for a node | `/dev/disk/by-id/nvme-…` |
| `storage.local_zfs.pool` | Pool name (identical on all nodes) | `nvme-local` |
| `storage.local_zfs.backup_quota` | Cap on the backup dataset | `500G` |
| `backups.retention` | Prune policy on `backup-local` | `keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=3` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb --yes local-zfs
   ```

2. Manual equivalent:

   ```bash
   # every node
   DEV=/dev/disk/by-id/nvme-<model>_<serial>
   wipefs -af $DEV; sgdisk --zap-all $DEV
   zpool create -f -o ashift=12 -o autotrim=on -O compression=zstd -O atime=off -O xattr=sa \
     -O acltype=posixacl -O dnodesize=auto -m none nvme-local $DEV
   zfs create -o recordsize=16k -o mountpoint=/nvme-local/vmdata nvme-local/vmdata
   zfs create -o recordsize=1M  -o mountpoint=/nvme-local/backup -o quota=500G nvme-local/backup

   # once (cluster-wide storage.cfg)
   pvesm add zfspool local-zfs --pool nvme-local/vmdata --content images,rootdir --sparse 1 --blocksize 16k
   pvesm add dir backup-local --path /nvme-local/backup --content backup --is_mountpoint yes \
     --prune-backups keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=3
   pvesm set local --content iso,vztmpl,import
   pvesm set local-lvm --disable 1
   ```

## Verify

```bash
zpool list -H -o name,health nvme-local          # ONLINE on every node
zfs get -H -o value mountpoint nvme-local/vmdata # /nvme-local/vmdata  (NOT "none")
pvesm status | grep -E 'local-zfs|backup-local'  # active
pct create 99198 <template> --storage local-zfs --rootfs local-zfs:2 && pct destroy 99198 --purge 1
```

## Rollback

```bash
pvesm remove backup-local; pvesm remove local-zfs; pvesm set local-lvm --disable 0
zpool destroy nvme-local      # every node; destroys all data on it
```

## Gotchas

- **`nvme-local/vmdata` must have a mountpoint.** If the pool root is created with
  `-m none` and `vmdata` inherits it, VMs (zvols) work but **every container fails**
  with `cannot mount 'nvme-local/vmdata/subvol-…': no mountpoint set`. The step sets
  the mountpoint explicitly and repairs older layouts.
- **Backups on the same node are not disaster recovery.** `backup-local` protects
  against Ceph or admin mistakes, not against losing the node. Add an off-cluster
  Proxmox Backup Server for real DR (see recipes/admin backups recipe).
- **Wiping a disk that held an old PVE install** (LVM VG `pve-OLD-…`):
  deactivate the VG first (`vgchange -an`), and reboot the node afterwards. See
  [stray-initramfs-udevd](../troubleshooting/stray-initramfs-udevd.md).
