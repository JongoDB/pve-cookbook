---
id: topologies/full-mesh
title: 3-node switchless full-mesh backend (SDN Fabrics / OpenFabric)
tested: untested
risk: high
runs_on: node
automated_by: none (manual; pvecb network refuses mode=mesh)
---

# 3-node switchless full-mesh backend (SDN Fabrics / OpenFabric)

Cable the three nodes directly to each other (pve1↔pve2, pve2↔pve3, pve1↔pve3)
with two spare ports per node. Then run a routed full mesh over those links using
PVE 9's SDN **Fabrics** (OpenFabric), so you get a fast, dedicated backend without
buying a switch. The trick is to reuse the **same backend IPs** as `/32` router
addresses on the fabric. Ceph mons, corosync link0 and EVPN peers keep their
addresses, so nothing has to be rebuilt.

## Preconditions

- Three nodes, each with 2 free ports, cabled as a triangle. Use **SFP28 or SFP+
  DAC cables** (passive copper, cheap, no transceivers). Avoid SFP-10G-T copper
  modules here (see [sfp-10g-t-flow-control](../troubleshooting/sfp-10g-t-flow-control.md)).
- Link lights up on all six ports: `ip -br link` shows them `UP`.
- PVE ≥ 9.0 with SDN Fabrics available (Datacenter → SDN → Fabrics).
- Cluster healthy; backend currently in `shared-bridge` or `dedicated` mode.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `nodes[].backend_ip` | Becomes the node's fabric router IP (/32) | `10.15.15.11` |
| Mesh ports | Two per node | `nic1`, `nic2` |
| `network.backend.cidr` | Fabric prefix | `10.15.15.0/24` |

## Steps

1. Cable the triangle and confirm link: `ethtool nic1 | grep -E 'Speed|Link detected'`.
2. Set `ceph osd set noout` (mons briefly move to new paths).
3. Create the fabric (GUI: Datacenter → SDN → Fabrics → Add OpenFabric):
   - Name `backend`, IPv4 prefix `10.15.15.0/24`.
   - Add every node with its router IP = its current `backend_ip`, and interfaces `nic1`, `nic2`.

   CLI equivalent (check the API schema on your version with `pvesh usage /cluster/sdn/fabrics/fabric -v`):

   ```bash
   pvesh create /cluster/sdn/fabrics/fabric --id backend --protocol openfabric --ip_prefix 10.15.15.0/24
   pvesh create /cluster/sdn/fabrics/node/backend --node_id pve1 --protocol openfabric \
     --ip 10.15.15.11 --interfaces name=nic1 --interfaces name=nic2
   # …repeat for pve2 (10.15.15.12) and pve3 (10.15.15.13)
   ```

4. Remove the old backend address **one node at a time**, then apply. Delete the
   `post-up ip addr add 10.15.15.x/24 dev vmbr0` and `pre-down` lines (or the
   dedicated stanza) from `/etc/network/interfaces` on all nodes, then:

   ```bash
   pvesh set /cluster/sdn      # applies fabric + reloads network on every node
   ```

5. Set `network.backend.mode: mesh` in the inventory for documentation, then `ceph osd unset noout`.

## Verify

```bash
vtysh -c 'show openfabric topology'           # both peers reachable via direct links
ip route | grep 10.15.15                       # /32 routes via nic1/nic2, not vmbr0
ping -c3 10.15.15.12; ping -c3 10.15.15.13
iperf3 -c 10.15.15.12                          # near line rate (e.g. ~9.4 Gbit/s on 10G, ~23 on 25G)
corosync-cfgtool -n                            # link0 still connected
ceph -s                                        # HEALTH_OK
```

Unplug one mesh cable: traffic must reroute through the third node within seconds.

## Rollback

Delete the fabric (`pvesh delete /cluster/sdn/fabrics/fabric/backend`), restore the
previous backend lines in `/etc/network/interfaces` (`pvecb network` re-adds them),
then `pvesh set /cluster/sdn` and `ifreload -a`.

## Gotchas

- **Only 3 nodes.** A full mesh doesn't scale past 3–4 nodes; buy a switch after that.
- **Keep corosync link1 on the management network.** It's your path if the mesh breaks.
- **Jumbo frames**: set MTU 9000 on mesh ports only after everything else works,
  and raise the EVPN vnet MTU to match (underlay − 50).
- **Untested in this cookbook.** The commands follow the PVE 9 Fabrics docs.
  Validate on your hardware and update the `tested:` stamp.
