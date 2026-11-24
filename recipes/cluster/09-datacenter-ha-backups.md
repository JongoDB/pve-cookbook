---
id: cluster/09-datacenter-ha-backups
title: Datacenter options, HA policy and nightly backups
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: low
runs_on: operator
automated_by: scripts/pvecb datacenter
---

# Datacenter options, HA policy and nightly backups

Set cluster-wide defaults:

- Live migration runs over the backend network.
- HA-managed guests migrate away when a node shuts down.
- Guests are placed by static load (CRS) and rebalanced on start.
- The console defaults to xterm.js.
- A nightly snapshot backup job covers every guest.

## Preconditions

- Cluster quorate; backend network up.
- A backup storage exists, e.g. `backup-local` from [06-local-zfs](06-local-zfs.md) or a PBS datastore.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `ha.shutdown_policy` | `migrate`, `freeze`, `failover` or `conditional` | `migrate` |
| `ha.crs` | Cluster resource scheduler mode | `static` |
| `backups.schedule` | systemd calendar spec | `01:30` |
| `backups.storage` | Target storage | `backup-local` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb datacenter
   ```

2. Manual equivalent:

   ```bash
   pvesh set /cluster/options \
     --migration type=secure,network=10.15.15.0/24 \
     --ha shutdown_policy=migrate \
     --crs ha=static,ha-rebalance-on-start=1 \
     --console xtermjs --next-id lower=100,upper=999999

   pvesh create /cluster/backup --id nightly-all --schedule '01:30' --storage backup-local \
     --all 1 --mode snapshot --compress zstd --enabled 1 --repeat-missed 1 \
     --notes-template '{{guestname}} on {{node}}' --comment 'Nightly snapshot backup of all guests'
   ```

3. Put guests under HA as you create them (PVE 9 uses HA **rules** instead of groups):

   ```bash
   ha-manager add vm:101 --state started --max_restart 2 --max_relocate 2
   # pin/prefer nodes with a node-affinity rule (GUI: Datacenter → HA → Rules)
   ```

## Verify

```bash
pvesh get /cluster/options --output-format json      # migration network, ha, crs set
pvesh get /cluster/backup                             # nightly-all enabled
vzdump <test-id> --storage backup-local --mode snapshot   # one manual run succeeds
```

## Rollback

```bash
pvesh delete /cluster/backup/nightly-all
pvesh set /cluster/options --delete migration,ha,crs,console
```

## Gotchas

- **`type=secure` migration** tunnels through SSH. On a trusted, dedicated backend
  you can use `type=insecure` for roughly 2× throughput. Never do that on a shared LAN.
- **`shutdown_policy=migrate`** only moves **HA-managed** guests. Unmanaged guests
  are shut down with the node.
- **Backups on node-local storage** are skipped for guests whose node is down. Pair
  this job with an off-cluster PBS target for real disaster recovery.
