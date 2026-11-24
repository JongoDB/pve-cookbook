---
id: cluster/01-preflight
title: Preflight — read-only readiness checks
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: low
runs_on: operator
automated_by: scripts/pvecb preflight
---

# Preflight — read-only readiness checks

Before anything changes, inventory every node: versions, hostnames, IPs, disk
roles, the uplink transceiver and flow control, time sync and apt health. Fix
every `✗` before continuing. `!` warnings are judgement calls.

## Preconditions

- `inventory.yaml` exists and lists every node with `ssh`, `mgmt_ip` and `backend_ip`.
- Key-based root SSH to each node works: `ssh -o BatchMode=yes root@<node> true`.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `nodes[].ssh` | SSH target for each node | `root@192.0.2.11` |
| `nodes[].mgmt_ip` | Must already be configured on the node | `192.0.2.11` |
| `storage.ceph.osd_model_match` | Disk model substring selecting OSD disks | `3.84TB` |
| `storage.local_zfs.model_match` | Disk model substring for the local ZFS disk | `800GB` |
| `network.mgmt.uplink` | Physical uplink NIC | `nic0` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb preflight
   ```

2. Manual equivalent, on each node:

   ```bash
   pveversion; uname -r; hostname -s
   ip -br a                                   # mgmt IP present?
   test -f /etc/pve/corosync.conf && echo "already clustered"
   qm list; pct list                          # joining nodes must be empty
   lsblk -d -o NAME,SIZE,ROTA,MODEL,TRAN      # disk roles
   lsblk -o NAME,FSTYPE                       # old ZFS/LVM/VMFS signatures?
   ethtool -m nic0 | grep -E 'Vendor PN|Transceiver'   # SFP-10G-T?
   ethtool -a nic0                            # pause frames
   timedatectl show -p NTPSynchronized --value
   apt-get update 2>&1 | grep -E '^(E|Err):'  # 401 = enterprise repo without subscription
   ```

## Verify

- `pvecb preflight` ends with `✓ [preflight] done`.
- Each node shows the expected `role=` for every disk, and exactly one disk is `role=BOOT`.

## Rollback

Read-only; nothing to undo.

## Gotchas

- **`existing=` on data disks** (zfs_member, LVM2_member, VMFS_volume_member)
  means old data. The Ceph and ZFS steps refuse to wipe unless
  `storage.wipe_confirm: true` **and** `--yes` are given. Confirm with the owner first.
- **Old Proxmox install on a secondary disk** (an LVM VG like `pve-OLD-xxxx`):
  wipe it, then reboot **before** clustering. A node that booted with it present can
  keep a stray initramfs udevd. See [stray-initramfs-udevd](../troubleshooting/stray-initramfs-udevd.md).
- **`module=SFP-10G-T`** with `flowcontrol=off/off`: set `network.flow_control: true`.
  The link reports 10000Mb/s but the copper side may negotiate 1G.
- **`apt_errors>0`** is normally the enterprise repo without a subscription (HTTP 401).
  `base-os` fixes this when `cluster.repos: no-subscription`.
