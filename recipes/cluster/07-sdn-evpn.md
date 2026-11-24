---
id: cluster/07-sdn-evpn
title: SDN — EVPN/VXLAN overlay networks with SNAT exit
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: medium
runs_on: operator
automated_by: scripts/pvecb sdn
---

# SDN — EVPN/VXLAN overlay networks with SNAT exit

Create cluster-wide L2/L3 overlay networks ("vnets") that follow guests across
nodes. They need no VLANs on the physical switch, because EVPN runs over plain
L3 on the backend. Every node is an exit node: guests reach the outside through
SNAT on whichever node they run on, and each vnet has an anycast gateway (`.1`)
present on all nodes.

## Preconditions

- Cluster quorate; backend IPs reachable between all nodes.
- `frr` and `ifupdown2` installed (they ship with PVE 9): `dpkg -l frr ifupdown2`.
- Underlay MTU known. VXLAN costs 50 bytes, so vnet MTU = underlay MTU − 50 (1500 → 1450).

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `sdn.evpn.asn` | Private BGP ASN | `65000` |
| `sdn.evpn.vrf_vxlan` | L3 VNI for the zone VRF | `10000` |
| `sdn.evpn.mtu` | vnet MTU | `1450` |
| `sdn.evpn.exit_nodes` | `all` or a comma list | `all` |
| `sdn.evpn.vnets[]` | `name`, `tag` (VNI), `cidr`, `gateway`, `alias` | `servers / 10010 / 10.10.10.0/24` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb sdn
   ```

2. Manual equivalent:

   ```bash
   # every node
   systemctl enable --now frr

   # founder
   pvesh create /cluster/sdn/controllers --controller evpn --type evpn --asn 65000 \
     --peers 10.15.15.11,10.15.15.12,10.15.15.13
   pvesh create /cluster/sdn/zones --zone evpn --type evpn --controller evpn --vrf-vxlan 10000 \
     --exitnodes pve1,pve2,pve3 --mtu 1450 --ipam pve --advertise-subnets 1
   pvesh create /cluster/sdn/vnets --vnet servers --zone evpn --tag 10010 --alias "Production servers"
   pvesh create /cluster/sdn/vnets/servers/subnets --type subnet --subnet 10.10.10.0/24 \
     --gateway 10.10.10.1 --snat 1
   # …repeat for dmz (10020, 10.10.20.0/24), lab (10030), infra (10040)
   pvesh set /cluster/sdn      # apply (reloads network on every node)
   ```

3. Optional, to reach vnets from the LAN without SNAT: on the LAN router add a
   static route `10.10.0.0/16 via <any node mgmt IP>`. For redundancy use ECMP to
   all nodes, or peer the router into BGP.

## Verify

```bash
vtysh -c 'show bgp l2vpn evpn summary'      # every peer Established
ip -br a | grep -E 'servers|vrf_evpn'        # vnet bridges up with gateway .1 on every node
# with a guest on vnet servers:
pct exec <id> -- ping -c3 <guest-on-another-node>        # cross-node overlay
pct exec <id> -- ping -c3 1.1.1.1                        # SNAT egress
pct exec <id> -- ping -c2 -M do -s 1422 <other-guest>    # full 1450 MTU path
```

`scripts/pvecb validate` runs these checks with throwaway containers.

## Rollback

```bash
pvesh delete /cluster/sdn/vnets/servers/subnets/<subnet-id>
pvesh delete /cluster/sdn/vnets/servers
pvesh delete /cluster/sdn/zones/evpn
pvesh delete /cluster/sdn/controllers/evpn
pvesh set /cluster/sdn
```

Delete the guests' NICs on a vnet first. A vnet that is in use can't be removed.

## Gotchas

- **Guests on a vnet can't ping the gateway** while the datacenter firewall drops ICMP
  from the overlay to the host. Allow `Ping` from the vnet range. The firewall step
  does this when `firewall.overlay_ping: true`.
- **MTU blackholes**: leave guest MTU at the vnet MTU (1450 on a 1500 underlay).
  With jumbo frames end to end on the backend you can raise both.
- **EVPN peers use backend IPs**, so moving the backend to a full mesh later keeps
  SDN working unchanged.
- **DHCP**: PVE's built-in SDN DHCP covers Simple zones only. On EVPN vnets, use
  static IPs or cloud-init, or run a DHCP server inside a vnet.
