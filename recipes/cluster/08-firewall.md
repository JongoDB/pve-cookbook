---
id: cluster/08-firewall
title: Datacenter firewall with a dead-man switch
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: high
runs_on: operator
automated_by: scripts/pvecb firewall
---

# Datacenter firewall with a dead-man switch

Enable the PVE firewall cluster-wide with an inbound DROP policy:

- Admin networks (the `management` ipset) get the GUI, SSH and consoles.
- The backend subnet and node management IPs are trusted node-to-node.

Enabling DROP remotely can lock you out, so a timer is armed first. It
auto-disables the firewall after 3 minutes unless you prove access and disarm it.

## Preconditions

- You know which networks admins connect from, **including the one you're on now**.
- Cluster quorate.
- Out-of-band console access available as a last resort.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `firewall.management_cidrs` | Admin networks (GUI 8006, SSH 22, consoles) | `[192.0.2.0/24]` |
| `network.backend.cidr` | Trusted node-to-node subnet | `10.15.15.0/24` |
| `nodes[].mgmt_ip` | Trusted node mgmt IPs (corosync link1, API proxying) | `192.0.2.11` |
| `firewall.overlay_ping` | Allow ICMP from vnets to anycast gateways | `true` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb firewall
   ```

2. Manual equivalent (founder):

   ```bash
   pvesh create /cluster/firewall/ipset --name management
   pvesh create /cluster/firewall/ipset/management --cidr 192.0.2.0/24
   pvesh create /cluster/firewall/ipset --name cluster-backend
   pvesh create /cluster/firewall/ipset/cluster-backend --cidr 10.15.15.0/24
   pvesh create /cluster/firewall/ipset --name cluster-nodes
   for ip in 192.0.2.11 192.0.2.12 192.0.2.13; do pvesh create /cluster/firewall/ipset/cluster-nodes --cidr $ip; done

   pvesh create /cluster/firewall/groups --group pve-hosts
   pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --source +cluster-backend --enable 1
   pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --source +cluster-nodes --enable 1
   pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --macro Ping --source +management --enable 1
   pvesh create /cluster/firewall/aliases --name sdn-overlay --cidr 10.10.0.0/16
   pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --macro Ping --source sdn-overlay --enable 1
   pvesh create /cluster/firewall/rules --type group --action pve-hosts --enable 1
   pvesh set /cluster/firewall/options --policy_in DROP --policy_out ACCEPT --ebtables 1
   pve-firewall compile >/dev/null   # must not error

   # dead-man switch, then enable
   systemd-run --unit fw-deadman --on-active=180 /usr/bin/pvesh set /cluster/firewall/options --enable 0
   pvesh set /cluster/firewall/options --enable 1
   # from your workstation, open a NEW ssh session and load https://<node>:8006 — then:
   systemctl stop fw-deadman.timer
   ```

## Verify

```bash
pve-firewall status                      # enabled/running on every node
curl -sk -o /dev/null -w '%{http_code}\n' https://192.0.2.11:8006   # 200 from an admin network
ceph -s | grep health; pvecm status | grep Quorate; vtysh -c 'show bgp summary'   # all unaffected
systemctl list-timers | grep -c fw-deadman   # 0 (disarmed)
```

## Rollback

```bash
pvesh set /cluster/firewall/options --enable 0
```

If you're locked out, wait for the dead-man timer to fire (3 min). Without it, use the
console and run `pve-firewall stop`.

## Gotchas

- **The built-in `management` ipset** controls access to 8006, 22, VNC/SPICE and 3128.
  If it doesn't contain your current network, enabling the firewall cuts you off.
- **Existing SSH sessions survive** a ruleset change (conntrack), but new ones don't.
  Always verify with a fresh connection before disarming.
- **Guest traffic is not filtered** by these rules. Guest firewalls are opt-in per VM/CT NIC (`firewall=1`).
- **SNAT and overlay forwarding keep working.** Host INPUT rules don't affect
  forwarded vnet traffic. The smoke test in [10-validate](10-validate.md) proves it.
