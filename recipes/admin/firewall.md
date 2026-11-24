---
id: admin/firewall
title: Firewall — datacenter, node, guest and vnet rules
tested: "PVE 9.2 · iptables backend · 3-node · 2026-11 (datacenter + host group verified; guest/vnet untested)"
risk: high
runs_on: node
automated_by: scripts/pvecb firewall
---

# Firewall

The PVE firewall is configured cluster-wide in `/etc/pve/firewall/` and enforced per node. Rules exist
at four levels: **datacenter** (all hosts), **node**, **guest** (per VM/CT NIC), and **vnet**
(forwarded traffic, nftables backend only). Misconfiguring the datacenter level can lock you out.
Always use the dead-man pattern below.

## Preconditions

- You are on a network listed in the `management` ipset: `pvesh get /cluster/firewall/ipset/management`
- Console access (IPMI/iDRAC/iLO or physical) as a last resort.

## Inputs

| Object | Purpose | Example |
|---|---|---|
| ipset `management` | Who may reach GUI/SSH/consoles | `192.0.2.0/24` |
| ipset `cluster-backend` | Node-to-node backend | `10.15.15.0/24` |
| alias | Named address | `lan = 192.0.2.0/24` |
| security group | Reusable rule set | `web-server` |

## Steps

### 1. Dead-man switch for risky changes

```bash
systemd-run --unit fw-deadman --on-active=180 /usr/bin/pvesh set /cluster/firewall/options --enable 0
pvesh set /cluster/firewall/options --enable 1           # or apply your rule change
# open a NEW ssh session and the GUI from your admin machine; if both work:
systemctl stop fw-deadman.timer
```

### 2. Objects

```bash
pvesh create /cluster/firewall/aliases --name lan --cidr 192.0.2.0/24 --comment "Office LAN"
pvesh create /cluster/firewall/ipset --name web-clients --comment "Allowed to reach web tier"
pvesh create /cluster/firewall/ipset/web-clients --cidr 192.0.2.0/24
```

### 3. A reusable security group for guests

```bash
pvesh create /cluster/firewall/groups --group web-server --comment "HTTP/S from clients, SSH from admins"
pvesh create /cluster/firewall/groups/web-server --type in --action ACCEPT --macro HTTPS --source +web-clients --enable 1
pvesh create /cluster/firewall/groups/web-server --type in --action ACCEPT --macro HTTP  --source +web-clients --enable 1
pvesh create /cluster/firewall/groups/web-server --type in --action ACCEPT --macro SSH   --source +management --enable 1
pvesh create /cluster/firewall/groups/web-server --type in --action ACCEPT --macro Ping  --enable 1
```

### 4. Enable a guest firewall

```bash
VMID=120 NODE=pve2
qm set $VMID --net0 virtio,bridge=servers,firewall=1          # the NIC flag must be set
pvesh set /nodes/$NODE/qemu/$VMID/firewall/options --enable 1 --policy_in DROP --policy_out ACCEPT \
  --ipfilter 1 --macfilter 1 --log_level_in info
pvesh create /nodes/$NODE/qemu/$VMID/firewall/rules --type group --action web-server --enable 1
# Containers: /nodes/$NODE/lxc/$VMID/firewall/...  and pct set ... --net0 ...,firewall=1
```

`--ipfilter 1` drops traffic from IPs the guest is not configured with (anti-spoofing). It uses the
IPs from the guest config or the `ipfilter-net0` ipset.

### 5. Node-level rules

Rarely needed. Put host rules at the datacenter level so all nodes match:

```bash
pvesh create /nodes/pve1/firewall/rules --type in --action ACCEPT --proto tcp --dport 9100 --source 10.10.40.0/24 --enable 1 --comment "node_exporter from infra"
```

### 6. vnet firewall (forwarded traffic, nftables only)

```bash
# per node, opt in to the nftables backend (tech preview in PVE 8/9):
pvesh set /nodes/pve1/firewall/options --nftables 1      # repeat per node, then reboot or restart proxmox-firewall
pvesh set /cluster/sdn/vnets/servers/firewall/options --enable 1 --policy_forward ACCEPT
pvesh create /cluster/sdn/vnets/servers/firewall/rules --type forward --action DROP --source 10.10.30.0/24 --enable 1 --comment "lab cannot reach servers"
```

### 7. Why is this blocked?

```bash
pvesh set /cluster/firewall/options --log_ratelimit enable=1,rate=10/second
pvesh set /nodes/pve1/firewall/options --log_level_in info     # host
journalctl -fu pve-firewall                                    # or: GUI → node → Firewall → Log
pve-firewall compile | less                                    # the generated ruleset
pve-firewall simulate --from outside --to vm120 --source 192.0.2.50 --dest 10.10.10.30 --dport 443 --protocol tcp --verbose 1
```

## Verify

```bash
pve-firewall status                              # enabled/running on every node
pvesh get /cluster/firewall/options
pvesh get /nodes/pve2/qemu/120/firewall/options
```

From an allowed host the service answers; from a disallowed host it times out (DROP) rather than
being refused (REJECT).

## Rollback

```bash
pvesh set /cluster/firewall/options --enable 0                 # instant, cluster-wide
pvesh set /nodes/pve2/qemu/120/firewall/options --enable 0     # one guest
```

Locked out completely: on the node console run `pve-firewall stop`. The setting persists in
`/etc/pve/firewall/cluster.fw` (`enable: 0`).

## Gotchas

- The `management` ipset implicitly allows GUI (8006), SSH (22), SPICE (3128) and VNC (5900–5999). If it is empty, the local network detected from the node's IP is used.
- Corosync between cluster members is allowed automatically. Ceph, BGP (179/tcp) and VXLAN (4789/udp) are **not**; allow the backend network explicitly.
- A guest rule has no effect unless the **NIC** has `firewall=1` **and** the guest firewall is enabled.
- `policy_in DROP` at the datacenter applies to hosts, not guests. Guests have their own policy.
- Rules are evaluated top to bottom; position matters (`--pos`).
- ICMP to SDN anycast gateways is host INPUT traffic. Allow `Ping` from the vnet ranges if you want gateways to answer.
