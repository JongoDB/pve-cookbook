---
id: admin/networks-sdn
title: SDN day-2 — zones, vnets, subnets, IPAM, LAN routing
tested: "PVE 9.2 · EVPN zone · 3-node · 2026-11 (vnet add verified; VLAN/simple zones untested)"
risk: medium
runs_on: node
automated_by: scripts/pvecb sdn
---

# SDN day-2 operations

Add networks for guests without touching each node's `/etc/network/interfaces`. All SDN objects are
cluster-wide and staged until applied with `pvesh set /cluster/sdn`.

| Zone type | Use when | Spans nodes | Needs switch config |
|---|---|---|---|
| `simple` | NAT/isolated net on one node, optional built-in DHCP | No (same subnet per node, not connected) | No |
| `vlan` | Guests must sit on existing LAN VLANs | Yes | Managed switch with trunk ports |
| `vxlan` | L2 overlay without BGP | Yes | No (UDP 4789 between nodes) |
| `evpn` | Routed overlay with anycast gateways, SNAT exits | Yes | No |

## Preconditions

- `frr` running for EVPN: `systemctl is-active frr`
- No pending SDN changes you did not make: `pvesh get /cluster/sdn --pending 1` (review before applying)

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `VNET` / `TAG` | vnet name (max 8 chars) / VXLAN VNI or VLAN ID | `apps` / `10050` |
| `CIDR` / `GW` | Subnet and gateway | `10.10.50.0/24` / `10.10.50.1` |

## Steps

### Add a vnet to the EVPN zone

```bash
pvesh create /cluster/sdn/vnets --vnet apps --zone evpn --tag 10050 --alias "Application tier"
pvesh create /cluster/sdn/vnets/apps/subnets --type subnet --subnet 10.10.50.0/24 --gateway 10.10.50.1 --snat 1
pvesh set /cluster/sdn                       # apply on all nodes
```

### VLAN zone (when a managed switch trunks VLANs to the nodes)

```bash
# vmbr0 must be VLAN-aware: in /etc/network/interfaces add 'bridge-vlan-aware yes' and 'bridge-vids 2-4094'
pvesh create /cluster/sdn/zones --zone lan --type vlan --bridge vmbr0 --ipam pve
pvesh create /cluster/sdn/vnets --vnet iot --zone lan --tag 30 --alias "IoT VLAN 30"
pvesh set /cluster/sdn
```

### Simple zone with DHCP (single-node lab/NAT network)

```bash
apt-get install -y dnsmasq && systemctl disable --now dnsmasq   # PVE runs per-zone instances itself
pvesh create /cluster/sdn/zones --zone nat --type simple --dhcp dnsmasq --ipam pve
pvesh create /cluster/sdn/vnets --vnet natlab --zone nat
pvesh create /cluster/sdn/vnets/natlab/subnets --type subnet --subnet 10.99.0.0/24 --gateway 10.99.0.1 \
  --snat 1 --dhcp-range start-address=10.99.0.100,end-address=10.99.0.200
pvesh set /cluster/sdn
```

### Attach a guest

```bash
qm set 120 --net0 virtio,bridge=apps          # VM
pct set 110 --net0 name=eth0,bridge=apps,ip=10.10.50.20/24,gw=10.10.50.1    # CT
```

Restrict who may use a vnet: `pveum acl modify /sdn/zones/evpn/apps --groups operators --roles PVESDNUser`.

### Reach EVPN vnets from the LAN

Each node SNATs outbound traffic, but LAN hosts cannot initiate connections to `10.10.0.0/16` until
your LAN router has a route:

```text
10.10.0.0/16 via 192.0.2.11   (any node's management IP; add more for ECMP if the router supports it)
```

Then allow the LAN in the guest or vnet firewall as needed. If routes are asymmetric, disable SNAT on
the subnet (`--snat 0`) so return traffic is not rewritten.

### IPAM

```bash
pvesh get /cluster/sdn/ipams/pve/status       # allocated IPs per subnet
```

## Verify

```bash
pvesh get /cluster/sdn/vnets --output-format json-pretty
ip -br a show apps                              # gateway 10.10.50.1 present on every node
vtysh -c 'show bgp l2vpn evpn summary'          # all peers Established (EVPN)
pct exec 110 -- ping -c2 10.10.50.1
```

## Rollback

```bash
pvesh delete /cluster/sdn/vnets/apps/subnets/evpn-10.10.50.0-24
pvesh delete /cluster/sdn/vnets/apps
pvesh set /cluster/sdn
```

Before applying, revert staged-but-unapplied changes with `pvesh set /cluster/sdn --lock-token ...` or
simply delete the objects again; nothing reaches the nodes until `pvesh set /cluster/sdn`.

## Gotchas

- Deleting a vnet that guests still use leaves those NICs on a missing bridge; the guest fails to start.
- vnet names are limited to 8 characters.
- EVPN/VXLAN reduce MTU by 50 bytes; set the zone MTU (default 1450 on a 1500 underlay).
- The VLAN zone on an unmanaged switch may "work" for some frames and silently drop others; only use it with a managed switch.
- The subnet ID used in API paths is `<zone>-<network>-<prefix>`, e.g. `evpn-10.10.50.0-24`.
