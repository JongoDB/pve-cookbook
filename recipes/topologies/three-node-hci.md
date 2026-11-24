---
id: topologies/three-node-hci
title: 3+ node hyperconverged cluster (Ceph + EVPN) — flagship
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: high
runs_on: operator
automated_by: scripts/pvecb all
---

# 3+ node hyperconverged cluster (Ceph + EVPN) — flagship

The reference build: three or more identical nodes, each running compute, Ceph
storage and EVPN networking. Any single node can fail without losing data or
quorum, and HA restarts its guests elsewhere. This recipe strings the cluster
recipes together. [examples/3-node-hyperconverged](../../examples/3-node-hyperconverged/README.md)
walks through a real run.

## Preconditions

- 3 or more nodes with PVE 9 installed, the same hostname scheme, and static management IPs.
- On each node: one boot disk, at least 2 identical data disks for OSDs (NVMe/SSD), and optionally one fast local disk.
- A backend path between nodes. A dedicated ≥10G network is best; a secondary IP on
  the management link works to start with (see [03-network-backend](../cluster/03-network-backend.md)).
- RAM: guests + about 8 GiB per OSD + 4 GiB for the host.

## Inputs

Everything comes from `inventory.yaml`. Start from `inventory.example.yaml`, which
already describes this topology.

## Steps

1. [01-preflight](../cluster/01-preflight.md): `scripts/pvecb preflight`
2. [02-base-os](../cluster/02-base-os.md): `scripts/pvecb base-os`, then reboot nodes that got a new kernel
3. [03-network-backend](../cluster/03-network-backend.md): `scripts/pvecb network`
4. [04-cluster](../cluster/04-cluster.md): `scripts/pvecb cluster`
5. [05-ceph](../cluster/05-ceph.md): `scripts/pvecb --yes ceph`
6. [06-local-zfs](../cluster/06-local-zfs.md): `scripts/pvecb --yes local-zfs` (optional)
7. [07-sdn-evpn](../cluster/07-sdn-evpn.md): `scripts/pvecb sdn`
8. [08-firewall](../cluster/08-firewall.md): `scripts/pvecb firewall`
9. [09-datacenter-ha-backups](../cluster/09-datacenter-ha-backups.md): `scripts/pvecb datacenter`
10. [10-validate](../cluster/10-validate.md): `scripts/pvecb validate`, then a reboot test of one node

Or run it all at once after preflight is clean: `scripts/pvecb --yes all`.

## Verify

```bash
scripts/pvecb validate     # health OK on every node + smoke test passes
```

Expected end state on 3 nodes:

- `pvecm status`: 3/3 votes, 2 corosync links per peer.
- `ceph -s`: HEALTH_OK, 3 mons, 3 mgrs (1 active), 3 MDS (1 active, 1 standby-replay), all OSDs up/in.
- `pvesm status`: `vm-pool`, `cephfs`, `local-zfs` and `backup-local` active; `local-lvm` disabled.
- 4 EVPN vnets with `.1` gateways on every node, and BGP Established to every peer.
- Firewall enabled; nightly backup job present.

## Rollback

See each step. Plan rollback of steps 4–5 as "reinstall the node".

## Gotchas

- **Two-node failure = no quorum** in a 3-node cluster. That's expected, and it's why
  maintenance reboots go one node at a time with `noout` set.
- **Capacity planning**: usable Ceph ≈ raw / 3. Keep below 80%.
- **Upgrade the backend later without a rebuild**: the backend IPs never change, so
  moving from shared-bridge to dedicated or [full-mesh](full-mesh.md) only moves addresses.
