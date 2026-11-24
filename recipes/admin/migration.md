---
id: admin/migration
title: Migration — live, restart, bulk and cross-cluster
tested: "PVE 9.2 · 3-node HCI · 2026-11 (HA relocate of CT verified; live VM and remote migration untested)"
risk: medium
runs_on: node
---

# Migration

| Kind | Guest | Downtime | Needs |
|---|---|---|---|
| **Live** (`qm migrate --online`) | VM | ~none (memory copied while running) | Same CPU type available on target (`cpu: x86-64-v3` etc. for mixed hosts) |
| **Restart** (`pct migrate --restart`) | CT | seconds (stop → move → start) | Containers cannot live-migrate |
| **Offline** | VM/CT | full | — |
| **With local disks** (`--with-local-disks`) | VM | live, but copies disks | Time proportional to disk size |
| **Remote** (`qm remote-migrate`) | VM/CT | live or restart | API token on the target cluster (**experimental**) |

Disks on shared storage (Ceph `vm-pool`) do not move; only RAM/state crosses the network. The
migration network is set cluster-wide (`pvecb datacenter` sets it to the backend network).

## Preconditions

- `pvesh get /cluster/options | grep migration` shows the intended network.
- Target node has the guest's storage, vnets and (for passthrough) the mapped device.
- Free RAM on target ≥ guest RAM.

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `ID` / `TARGET` | Guest / destination node | `120` / `pve3` |

## Steps

### Single guest

```bash
qm migrate 120 pve3 --online 1                         # VM, live
qm migrate 121 pve3 --online 1 --with-local-disks 1 --targetstorage local-zfs   # VM on local-zfs
pct migrate 110 pve3 --restart 1 --timeout 120         # container
ha-manager crm-command migrate vm:120 pve3             # HA-managed VM (let HA do it)
ha-manager crm-command relocate ct:110 pve3            # HA-managed CT (stop/start)
```

### Bulk (evacuate a node)

```bash
pvenode migrateall pve3 --maxworkers 2 --with-local-disks 1     # run on the source node
```

Prefer [maintenance-mode](maintenance-mode.md) for HA guests; `migrateall` is for the rest.

### Bandwidth

```bash
pvesh set /cluster/options --bwlimit migration=409600    # KiB/s (~400 MiB/s); protect Ceph/corosync on shared links
```

### Cross-cluster (remote) migration

On the **target** cluster create a token with rights on the target storage/bridge/VMID range:

```bash
pveum user add migrate@pve
pveum user token add migrate@pve remote --privsep 0          # save secret
pveum acl modify / --users migrate@pve --roles PVEVMAdmin,PVEDatastoreUser,PVESDNUser
```

On the **source** cluster:

```bash
qm remote-migrate 120 4120 \
  'host=203.0.113.21,apitoken=PVEAPIToken=migrate@pve!remote=<secret>,fingerprint=<target-cert-sha256>' \
  --target-bridge servers --target-storage vm-pool --online 1
pct remote-migrate 110 4110 '<same endpoint>' --target-bridge servers --target-storage vm-pool --restart 1
```

For many clusters, **Proxmox Datacenter Manager** gives the same remote migration from one UI.

## Verify

```bash
qm status 120 && pvesh get /cluster/resources --type vm --output-format json | grep -A3 '"vmid":120' | grep node
pct status 110
```

Check the task log: `pvesh get /nodes/<source>/tasks --typefilter qmigrate --limit 1`.

## Rollback

Migrate back the same way. A failed live migration leaves the guest running on the source.

## Gotchas

- Mixed CPU generations: set guests to a common baseline (`--cpu x86-64-v3`) or live migration fails or crashes guests.
- Guests with PCI passthrough cannot live-migrate. Use HA node-affinity and accept stop/start.
- `--with-local-disks` over a 1G link is slow. Throttle it or schedule it.
- Remote migration is marked experimental. Test on a throwaway guest (VMID ≥ 99000) first.
- `secure` migration type tunnels over SSH. `insecure` is faster but sends RAM in clear text; use it only on a dedicated, isolated network.
