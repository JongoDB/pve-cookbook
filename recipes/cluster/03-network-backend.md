---
id: cluster/03-network-backend
title: Backend network and uplink flow control
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: medium
runs_on: operator
automated_by: scripts/pvecb network
---

# Backend network and uplink flow control

Give every node an address on a dedicated **backend** subnet. That subnet carries
Ceph public and cluster traffic, corosync link0, live migration and EVPN peering.
Keeping these IPs stable is what lets you move the backend onto better hardware
later (a dedicated NIC or a switchless full mesh) without rebuilding Ceph or the cluster.

## Preconditions

- Base OS done; `/etc/network/interfaces` has the management bridge (default `vmbr0`) with `bridge-fd 0`.
- You have out-of-band access (IPMI/iDRAC/console) in case a network change cuts SSH.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `network.backend.cidr` | Backend subnet | `10.15.15.0/24` |
| `network.backend.mode` | `shared-bridge`, `dedicated` or `mesh` | `shared-bridge` |
| `network.backend.iface` | Interface for `dedicated` | `bond1` |
| `network.mgmt.bridge` / `uplink` | Mgmt bridge and its physical port | `vmbr0` / `nic0` |
| `network.flow_control` | Enable 802.3x pause frames on the uplink | `true` |
| `nodes[].backend_ip` | Per-node backend address | `10.15.15.11` |

Modes:

- **shared-bridge**: a secondary IP on the mgmt bridge. Works through any dumb
  switch, but shares bandwidth with everything else. Use it as a stepping stone.
- **dedicated**: a separate NIC or bond (recommended when you have a switch with spare ports).
- **mesh**: a switchless 3-node full mesh. See [topologies/full-mesh](../topologies/full-mesh.md).

## Steps

1. Automated:

   ```bash
   scripts/pvecb network
   ```

2. Manual equivalent (shared-bridge, on pve1; adjust the IP per node). Edit
   `/etc/network/interfaces`:

   ```text
   iface nic0 inet manual
       post-up /usr/sbin/ethtool -A nic0 rx on tx on || true

   auto vmbr0
   iface vmbr0 inet static
       address 192.0.2.11/24
       gateway 192.0.2.1
       bridge-ports nic0
       bridge-stp off
       bridge-fd 0
       post-up ip addr add 10.15.15.11/24 dev vmbr0 || true
       pre-down ip addr del 10.15.15.11/24 dev vmbr0 || true
   ```

   Then apply:

   ```bash
   ifreload -a
   ethtool -A nic0 rx on tx on
   ```

   Dedicated mode instead appends:

   ```text
   auto bond1
   iface bond1 inet static
       address 10.15.15.11/24
       mtu 9000
   ```

## Verify

```bash
ip -br a | grep 10.15.15.                         # address present on every node
ping -c2 10.15.15.12 && ping -c2 10.15.15.13       # every pair
ethtool -a nic0                                   # RX: on  TX: on (if flow_control)
# burst test — paced iperf hides microburst loss, flood ping does not:
ping -f -c 3000 -s 1400 10.15.15.12 | grep loss   # 0% expected
```

## Rollback

`cp /etc/network/interfaces.pre-pve-cookbook /etc/network/interfaces && ifreload -a`
(the step saves that backup on first run).

## Gotchas

- **`bridge-fd: value of out range "0"` warnings** from `ifreload --syntax-check` are
  harmless PVE defaults, but they make the check exit non-zero. Don't gate on that exit code.
- **Never put comment lines inside an interface stanza.** The PVE GUI parser can choke on them.
  `post-up` and `pre-down` lines are preserved by the GUI.
- **SFP-10G-T into a 1G/2.5G switch**: the NIC reports 10000Mb/s while the copper
  side runs at 1G. Without pause frames, bursts of full-size packets drop (about 60%
  measured with tcpdump), which wedges corosync/pmxcfs. Always set `flow_control: true` there.
  See [sfp-10g-t-flow-control](../troubleshooting/sfp-10g-t-flow-control.md).
- **Measure real throughput** with `iperf3 -c <peer>` (TCP). If it shows ~940 Mbit/s,
  the path is 1G no matter what `ethtool` says. Plan Ceph recovery limits accordingly.
