---
id: admin/storage-ceph-ops
title: Ceph day-2 — OSDs, flags, pools, scrubbing, capacity
tested: "PVE 9.2 · Ceph 19.2 (squid) · 9 NVMe OSDs · 2026-11 (read-only commands verified)"
risk: high
runs_on: node
---

# Ceph day-2 operations

Replace failed disks, add capacity, put the cluster in maintenance, and watch capacity before it bites.
Ceph refuses writes when an OSD reaches `full` (95% by default), so act at `nearfull` (85%).

## Preconditions

- `ceph -s` shows all mons in quorum.
- You know the replication rule: `ceph osd pool get vm-pool size` (3) and `min_size` (2).

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `OSD` | OSD id | `4` |
| `DEV` | New disk | `/dev/nvme2n1` |
| `POOL` | Pool | `vm-pool` |

## Steps

### Status at a glance

```bash
ceph -s
ceph health detail
ceph osd tree
ceph osd df tree            # per-OSD fill %, look for imbalance
ceph df                     # per-pool usable space (already divided by replica count)
ceph osd pool autoscale-status
```

### Replace a failed OSD

```bash
ceph osd out $OSD                                 # start moving data off (if not already down/out)
while ! ceph osd safe-to-destroy osd.$OSD; do sleep 60; done
pveceph osd destroy $OSD --cleanup 1              # on the node that holds it
# physically replace the disk, then:
pveceph osd create $DEV --crush-device-class nvme
```

### Add capacity

Add OSDs evenly across hosts (the failure domain is `host`). Data rebalances automatically:

```bash
pveceph osd create /dev/nvme4n1 --crush-device-class nvme
ceph -w                                           # watch backfill; Ctrl-C when HEALTH_OK
```

### Planned node maintenance (no rebalancing storm)

```bash
ceph osd set noout          # down OSDs are not marked out → no data movement
# ... reboot/patch ONE node, wait for its OSDs to be up ...
ceph osd unset noout
```

Use `ceph osd set-group noout pve2` to scope the flag to one host instead of the whole cluster.

### Pool settings

```bash
ceph osd pool set vm-pool target_size_ratio 0.9   # tell the autoscaler what to expect
ceph osd pool set vm-pool pg_autoscale_mode on
ceph osd pool get vm-pool all
```

Do not lower `min_size` to 1 except in a documented emergency. It allows writes with a single copy.

### Scrubbing

```bash
ceph config set osd osd_scrub_begin_hour 0
ceph config set osd osd_scrub_end_hour 6
ceph pg deep-scrub <pgid>                          # on demand
ceph health detail | grep -i inconsistent && ceph pg repair <pgid>
```

### Capacity thresholds

```bash
ceph osd dump | grep -E 'full_ratio|backfillfull_ratio|nearfull_ratio'
ceph balancer status                               # upmap balancer keeps OSDs within a few %
```

Plan to expand before `ceph df` shows a pool above 70% used. Ceph needs free space to re-replicate
after a node loss: with 3 nodes and size=3, a dead node cannot re-replicate at all, and the cluster
runs degraded until it returns.

### CephFS content

```bash
pvesm set cephfs --content iso,vztmpl,snippets,import
ls /mnt/pve/cephfs/template/{iso,cache} /mnt/pve/cephfs/snippets
```

## Verify

```bash
ceph health                                         # HEALTH_OK
ceph osd stat                                       # N osds: N up, N in
ceph osd dump | grep '^flags'                       # no leftover noout/norebalance
```

## Rollback

- OSD destroyed by mistake: the data still exists on other replicas. Recreate the OSD and let it backfill.
- Flags: `ceph osd unset noout` / `norebalance` / `nobackfill`.

## Gotchas

- Never destroy more than `size - min_size` OSDs from different hosts at once (1 with 3/2).
- `ceph osd out` on several OSDs simultaneously can push the remaining ones past `nearfull`.
- Recovery traffic shares the network with clients. On ≤10G links keep `osd_mclock_profile high_client_ops`.
- An unscoped `noout` left set hides real failures. `scripts/pve-health.sh` warns about it (`ceph-flags`).
- `pveceph osd create` refuses disks with partitions or signatures. Wipe with `ceph-volume lvm zap --destroy $DEV` after triple-checking the device.
