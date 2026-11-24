---
id: cluster/05-ceph
title: Hyperconverged Ceph — mons, mgrs, OSDs, RBD pool, CephFS
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: high
runs_on: operator
automated_by: scripts/pvecb --yes ceph
---

# Hyperconverged Ceph — mons, mgrs, OSDs, RBD pool, CephFS

Install Ceph Squid on every node, then create:

- a monitor and a manager on each node
- one OSD per selected disk
- an NVMe-only replicated CRUSH rule with host failure domain
- an RBD pool for VM and CT disks (`size 3 / min_size 2`)
- CephFS for ISOs, templates and snippets shared across nodes

## Preconditions

- Cluster quorate with **3 or more** nodes. Ceph with 2 nodes is not supported here.
- Backend network carries the Ceph traffic (`network.backend.cidr`).
- NTP is synchronized on every node: `timedatectl show -p NTPSynchronized --value` returns `yes`.
- OSD disks are identified. `pvecb preflight` shows them as `role=ceph-osd`.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `storage.ceph.osd_model_match` | Model substring selecting OSD disks | `3.84TB` |
| `nodes[].osd_devices` | Explicit per-node list (overrides the match) | `[/dev/disk/by-id/nvme-…]` |
| `storage.ceph.device_class` | CRUSH device class | `nvme` |
| `storage.ceph.pool` / `size` / `min_size` | RBD pool | `vm-pool` / `3` / `2` |
| `storage.ceph.osd_memory_target_gib` | Memory per OSD | `8` |
| `storage.ceph.protect_client_io` | Throttle recovery (links ≤10G, shared) | `true` |
| `storage.wipe_confirm` | Allow erasing disks with existing data | `false` |

## Steps

1. Automated. Disks with existing data need **both** `storage.wipe_confirm: true` and `--yes`:

   ```bash
   scripts/pvecb --yes ceph
   ```

2. Manual equivalent:

   ```bash
   # every node
   yes | pveceph install --repository no-subscription --version squid

   # founder
   pveceph init --network 10.15.15.0/24 --cluster-network 10.15.15.0/24

   # every node
   pveceph mon create
   pveceph mgr create

   # tuning (founder)
   ceph config set osd osd_memory_target 8589934592
   ceph config set global mon_osd_down_out_interval 600
   ceph config set mgr mgr/balancer/mode upmap && ceph balancer on
   ceph config set osd osd_scrub_begin_hour 0 && ceph config set osd osd_scrub_end_hour 6
   # shared or <=10G links: protect client IO and corosync from recovery storms
   ceph config set osd osd_mclock_profile high_client_ops
   ceph config set osd osd_max_backfills 1
   ceph config set osd osd_recovery_max_active 1

   # every node, every OSD disk (wipe old signatures first if needed)
   wipefs -af /dev/nvme1n1 && sgdisk --zap-all /dev/nvme1n1 && blkdiscard -f /dev/nvme1n1
   pveceph osd create /dev/nvme1n1 --crush-device-class nvme

   # pools (founder)
   ceph osd crush rule create-replicated replicated-nvme default host nvme
   pveceph pool create vm-pool --size 3 --min_size 2 --application rbd \
     --crush_rule replicated-nvme --pg_autoscale_mode on --target_size_ratio 0.9 --add_storages 1
   ceph osd pool set vm-pool bulk true

   # CephFS (MDS on every node, then on the founder)
   pveceph mds create
   pveceph fs create --name cephfs --pg_num 32 --add-storage 1
   ceph osd pool set cephfs_data crush_rule replicated-nvme
   ceph osd pool set cephfs_metadata crush_rule replicated-nvme
   ceph fs set cephfs allow_standby_replay true
   pvesm set cephfs --content iso,vztmpl,snippets,import
   ```

## Verify

```bash
ceph -s          # HEALTH_OK; N mons in quorum; all OSDs up+in; all PGs active+clean
ceph osd tree    # OSDs evenly spread across hosts
pvesm status     # vm-pool and cephfs active on every node
# end to end: create a container on RBD from a node other than the founder
pct create 99199 cephfs:vztmpl/<debian-13-template> --storage vm-pool --rootfs vm-pool:2 && pct destroy 99199 --purge 1
```

Freshly created OSDs can show `down` for 10–30 s. Wait for `9 up` (or your count) before judging.

## Rollback

```bash
# destroy one OSD (data on it is gone; the cluster rebalances)
ceph osd out <id>; systemctl stop ceph-osd@<id>; pveceph osd destroy <id> --cleanup
# remove pools (needs mon_allow_pool_delete=true temporarily)
pveceph pool destroy vm-pool
# full teardown
pveceph purge   # on each node, after all OSDs, mons and pools are removed
```

## Gotchas

- **Usable capacity is about raw/3.** For example, 9 × 3.84 TB is about 31 TiB raw and about 10.7 TB usable.
  Keep it below 80% full: Ceph needs headroom to heal.
- **Throughput is bounded by the backend link.** On a 1G path, client writes cap at
  roughly 100 MB/s because of 3× replication, and an unthrottled rebuild can starve
  corosync. Keep `protect_client_io: true` until the backend is ≥10G and dedicated.
- **`pct create` fails with `mkfs.ext4 … does not exist and no size was specified`**
  on one node only: a stray initramfs udevd. See [stray-initramfs-udevd](../troubleshooting/stray-initramfs-udevd.md).
- **Maintenance:** set `ceph osd set noout` before rebooting a node and unset it after.
  Wait for the node's OSDs to be `up` again first.
