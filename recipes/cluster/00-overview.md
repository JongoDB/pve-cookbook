---
id: cluster/00-overview
title: Building a Proxmox VE cluster — overview and build order
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: low
runs_on: operator
automated_by: scripts/pvecb all
---

# Building a Proxmox VE cluster — overview and build order

Start here. This recipe tells you which topology to build, what order the build
runs in, and which `scripts/pvecb` step implements each recipe. Every cluster
recipe can be run either by the automated step or by hand with the manual commands
it lists. The two paths produce the same result.

## Preconditions

- Proxmox VE 9.x installed on every node (from the ISO), with a static management IP:
  `pveversion` prints `pve-manager/9.x`.
- The operator machine reaches every node as root over SSH with a key:
  `ssh -o BatchMode=yes root@<node> true` exits 0.
- The operator machine has `bash`, `ssh` and `python3` (PyYAML optional; the
  inventory is converted on the first node when it is missing).
- Nodes are **empty**: no guests. Joining a node that has guests is refused.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `inventory.yaml` | Single source of truth for every step | copy of `inventory.example.yaml` |
| `cluster.founder` | Node that creates the cluster | `pve1` |
| `network.backend.mode` | `shared-bridge`, `dedicated` or `mesh` | `shared-bridge` |
| `storage.ceph.enabled` | Hyperconverged Ceph (3+ nodes) | `true` |
| `sdn.evpn.enabled` | EVPN/VXLAN overlay networks | `true` |

## Steps

1. Pick a topology:

   | Nodes | Shared storage | Recipe |
   |---|---|---|
   | 1 | none (local ZFS) | [topologies/single-node](../topologies/single-node.md) |
   | 2 | ZFS replication + QDevice | [topologies/two-node-qdevice](../topologies/two-node-qdevice.md) |
   | 3+ | Ceph (hyperconverged) | [topologies/three-node-hci](../topologies/three-node-hci.md) — flagship |
   | 3, switchless backend | Ceph over full-mesh DACs | [topologies/full-mesh](../topologies/full-mesh.md) |

2. Write the inventory:

   ```bash
   cp inventory.example.yaml inventory.yaml
   $EDITOR inventory.yaml
   ```

3. Run the build in order. Each step is idempotent and can be re-run:

   | Order | `pvecb` step | Recipe | Risk |
   |---|---|---|---|
   | 1 | `preflight` | [01-preflight](01-preflight.md) | read-only |
   | 2 | `base-os` | [02-base-os](02-base-os.md) | low |
   | 3 | `network` | [03-network-backend](03-network-backend.md) | medium |
   | 4 | `cluster` | [04-cluster](04-cluster.md) | high |
   | 5 | `ceph` | [05-ceph](05-ceph.md) | high (wipes disks) |
   | 6 | `local-zfs` | [06-local-zfs](06-local-zfs.md) | high (wipes disk) |
   | 7 | `sdn` | [07-sdn-evpn](07-sdn-evpn.md) | medium |
   | 8 | `firewall` | [08-firewall](08-firewall.md) | high (lockout) |
   | 9 | `datacenter` | [09-datacenter-ha-backups](09-datacenter-ha-backups.md) | low |
   | 10 | `validate` | [10-validate](10-validate.md) | low (test guests 99901/99902) |

   ```bash
   scripts/pvecb preflight            # always first; read-only
   scripts/pvecb base-os network      # then reboot if a new kernel was installed
   scripts/pvecb cluster
   scripts/pvecb --yes ceph local-zfs # --yes + storage.wipe_confirm: true to erase disks
   scripts/pvecb sdn firewall datacenter validate
   ```

   `--dry-run` prints mutating commands without running them; read-only probes still run.

## Verify

```bash
scripts/pvecb validate
```

It must end with `✓ [validate] done`, and no `CRIT` lines may appear in the health output.

## Rollback

Each recipe has its own rollback section. Clustering and Ceph are the hard ones to
undo: plan on reinstalling a node rather than "unclustering" it.

## Gotchas

- **Never interrupt `pvecm add`.** A join killed halfway (Ctrl-C, SSH timeout)
  can wedge pmxcfs on every node. See [troubleshooting/pmxcfs-wedged](../troubleshooting/pmxcfs-wedged.md).
- **Test the uplink with bursts, not just ping.** Rate-adapting SFP-10G-T modules
  plugged into 1G switches pass pings and paced iperf but drop corosync bursts.
  See [troubleshooting/sfp-10g-t-flow-control](../troubleshooting/sfp-10g-t-flow-control.md).
- **Wipe old OS installs on secondary disks before the first boot.** A stale LVM
  volume group can leave a stray udevd behind, which breaks Ceph RBD containers.
  See [troubleshooting/stray-initramfs-udevd](../troubleshooting/stray-initramfs-udevd.md).
