---
id: topologies/single-node
title: Single node (local ZFS, no cluster)
tested: "PVE 9.2 · 2026-11 (steps exercised individually on a cluster node)"
risk: medium
runs_on: operator
automated_by: scripts/pvecb preflight base-os local-zfs sdn firewall datacenter
---

# Single node (local ZFS, no cluster)

One host, no shared storage, no HA. Use it for homelabs, edge sites, or the first
node of a future cluster. Storage is local ZFS, and networking is either the
management bridge or a Simple SDN zone. You can turn it into a cluster later by
running the `cluster` step with more nodes. The node keeps its guests as the
founder; joining nodes must be empty.

## Preconditions

- PVE 9 installed (ZFS root recommended for mirrored boot).
- Optionally, a second disk for `local-zfs`.

## Inputs

In `inventory.yaml`, list one node and set:

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `storage.ceph.enabled` | Must be false | `false` |
| `sdn.evpn.enabled` | EVPN needs peers; use a Simple zone instead | `false` |
| `network.backend.mode` | Not needed | leave the IP unused |
| `corosync.links` | Unused | — |

## Steps

1. `scripts/pvecb preflight base-os`
2. `scripts/pvecb --yes local-zfs` (if there's a data disk)
3. Optional NAT network for guests (Simple zone with DHCP):

   ```bash
   pvesh create /cluster/sdn/zones --zone local --type simple --ipam pve --dhcp dnsmasq
   pvesh create /cluster/sdn/vnets --vnet natnet --zone local
   pvesh create /cluster/sdn/vnets/natnet/subnets --type subnet --subnet 10.10.10.0/24 \
     --gateway 10.10.10.1 --snat 1 --dhcp-range start-address=10.10.10.100,end-address=10.10.10.200
   apt-get install -y dnsmasq && systemctl disable --now dnsmasq
   pvesh set /cluster/sdn
   ```

4. `scripts/pvecb firewall datacenter`

## Verify

```bash
scripts/pve-health.sh        # no CRIT
pvesm status                 # local-zfs active
```

## Rollback

As in the individual recipes.

## Gotchas

- **Backups on the same host aren't backups.** Add a PBS or NFS target elsewhere.
- **`cluster` step on one node**: skip it unless you want a one-node cluster now,
  which is harmless and makes adding nodes later identical to the 3-node flow.
