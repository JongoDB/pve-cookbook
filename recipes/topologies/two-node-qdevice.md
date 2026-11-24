---
id: topologies/two-node-qdevice
title: Two nodes + QDevice (ZFS replication, HA)
tested: untested
risk: high
runs_on: operator
automated_by: scripts/pvecb preflight base-os network cluster local-zfs firewall datacenter
---

# Two nodes + QDevice (ZFS replication, HA)

Two PVE nodes plus a tiny third vote (corosync QDevice on any small Linux box or
VM **outside** the cluster) give quorum when one node fails. There is no Ceph.
Guests live on `local-zfs`, with storage replication every few minutes to the
peer, so HA failover can lose up to one replication interval of writes.

## Preconditions

- Two PVE 9 nodes, plus one external Debian host for `corosync-qnetd`, reachable from both nodes.
- Identical ZFS pool names on both nodes (the `local-zfs` step does this).

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `nodes` | Exactly 2 | `pve1`, `pve2` |
| `storage.ceph.enabled` | Must be false | `false` |
| `storage.local_zfs.enabled` | Required | `true` |
| QDevice host | Not in inventory | `192.0.2.20` |

## Steps

1. `scripts/pvecb preflight base-os network cluster`
2. `scripts/pvecb --yes local-zfs`
3. QDevice:

   ```bash
   # on the external host
   apt-get install -y corosync-qnetd
   # on BOTH nodes
   apt-get install -y corosync-qdevice
   # on one node (needs root SSH to the qnetd host once)
   pvecm qdevice setup 192.0.2.20
   ```

4. Replication and HA per guest:

   ```bash
   pvesr create-local-job 101-0 pve2 --schedule '*/5'
   ha-manager add vm:101 --state started
   ```

5. `scripts/pvecb firewall datacenter`

## Verify

```bash
pvecm status | grep -E 'Total votes|Qdevice'   # 3 votes incl. Qdevice
pvesr status                                    # jobs OK, last sync recent
```

Power off one node: its HA guests should start on the survivor within about 2–3 minutes.

## Rollback

`pvecm qdevice remove`; `pvesr delete <job>`.

## Gotchas

- **Don't run the QDevice on either cluster node.** It has to survive the loss of either one.
- **Replication is asynchronous.** For zero data loss you need shared storage (3-node Ceph).
- **EVPN works with 2 peers**, but a Simple zone or plain bridges are usually enough here.
