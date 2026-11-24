---
id: admin/maintenance-mode
title: Node maintenance mode (HA-aware)
tested: "PVE 9.2 · 2026-11 (syntax verified)"
risk: medium
runs_on: node
---

# Node maintenance mode

Take one node out of service (hardware work, firmware, debugging) while HA keeps guests running
elsewhere. Combine with Ceph `noout` so its OSDs being down does not trigger rebalancing.

## Preconditions

- Cluster quorate and HA quorum OK: `ha-manager status | grep -q 'quorum OK'`
- Remaining nodes have the CPU/RAM for the moved guests.
- Device-bound guests (GPU passthrough, local disks) are understood. They cannot move and will be stopped.

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `N` | Node to maintain | `pve2` |

## Steps

1. Enter maintenance:

   ```bash
   ha-manager crm-command node-maintenance enable $N
   ceph osd set-group noout $N
   ```

   - **HA resources** on `$N` are migrated away (live for VMs on shared storage, restart for CTs)
     and will not be placed there while maintenance is on. Node-affinity rules with `--strict 1`
     that only allow `$N` leave the guest stopped.
   - **Non-HA guests** are untouched. Migrate them yourself (`qm migrate <id> <node> --online 1`,
     `pct migrate <id> <node> --restart 1`) or they stop if the node goes down.
   - The node stays a corosync/Ceph member; quorum is unaffected until it actually goes offline.

2. Do the work. Rebooting is fine; the node returns in maintenance.

3. Leave maintenance:

   ```bash
   ceph osd unset-group noout $N
   ha-manager crm-command node-maintenance disable $N
   ```

   With `crs ha-rebalance-on-start=1` (set by `pvecb datacenter`), HA may move guests back as load allows.

## Verify

```bash
ha-manager status | grep -E "lrm $N|maintenance"       # shows maintenance mode while enabled
pvesh get /nodes/$N/qemu --output-format json | grep -c '"status":"running"'   # 0 HA VMs left
ceph osd dump | grep -E '^flags|noout'
```

## Rollback

`ha-manager crm-command node-maintenance disable $N` and `ceph osd unset-group noout $N`.

## Gotchas

- Shutdown policy `migrate` (set in datacenter options) also moves HA guests on a plain `reboot`; maintenance mode makes it explicit and sticky.
- Maintenance mode is stored in the HA manager state. It survives reboots and must be disabled explicitly.
- Do not put two nodes of a 3-node Ceph cluster in maintenance and reboot them together.
- To stop HA from acting cluster-wide (e.g. network work affecting all nodes), use `ha-manager crm-command disarm-ha freeze` and `arm-ha` afterwards. That is not the same as maintenance mode.
