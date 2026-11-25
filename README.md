# pve-cookbook

**Recipes and tools for building and running Proxmox VE clusters, written so that both
humans and AI agents can follow them safely.**

Install Proxmox VE on one or more machines, fill in one inventory file, and go from bare
nodes to a production-grade cluster: Ceph shared storage, EVPN/VXLAN SDN, firewall, HA,
backups and health checks. Then keep it healthy with day-2 recipes for users, networks,
guests, monitoring and rolling updates.

```text
recipes/        step-by-step runbooks (Preconditions → Steps → Verify → Rollback → Gotchas)
  cluster/        build order for a new cluster
  topologies/     single node · 2-node + QDevice · 3+ node hyperconverged · switchless full mesh
  admin/          day-2: users/roles/tokens, guests, helper scripts, SDN, firewall, backups,
                  Ceph ops, health, monitoring, notifications, rolling updates, migration
  troubleshooting/ field-tested fixes for failures that are hard to diagnose
scripts/        pvecb (idempotent build runner), pve-health.sh, pve-app.sh
examples/       a worked 3-node hyperconverged build, incidents included
dashboard/      galley: a web cockpit for one or many clusters (Go + React, single binary)
```

## Quick start

```bash
git clone https://github.com/JongoDB/pve-cookbook && cd pve-cookbook
cp inventory.example.yaml inventory.yaml   # describe your nodes, networks, disks
scripts/pvecb preflight                    # read-only: hardware, disks, NICs, repos, time
scripts/pvecb --dry-run all                # see every change before it happens
scripts/pvecb base-os network cluster      # then: ceph local-zfs sdn firewall datacenter validate
```

Every step is idempotent: run it again and it changes nothing. Steps that wipe disks need
`storage.wipe_confirm: true` in the inventory **and** `--yes`.

Health of any node or cluster, at any time:

```bash
scp scripts/pve-health.sh root@pve1: && ssh root@pve1 ./pve-health.sh      # or --json
```

Deploy an app from the community-scripts catalog onto an SDN vnet, unattended:

```bash
./pve-app.sh search kuma
./pve-app.sh deploy uptimekuma --id 120 --vnet servers --ip 10.10.10.20/24 --gw 10.10.10.1 \
  --storage vm-pool --template-storage cephfs
```

## Using it with an AI agent

Agents should start at [`AGENTS.md`](AGENTS.md). It holds the golden rules (preflight first,
verify every step, never interrupt a cluster join, don't lock yourself out) and routes to
the right recipe.

For **Claude Code**, this repo is also a plugin:

```text
/plugin marketplace add JongoDB/pve-cookbook
/plugin install pve-cookbook@pve-cookbook
```

## What the reference build looks like

`examples/3-node-hyperconverged/` is a complete record of building three identical nodes into:

- Ceph Squid: 9 NVMe OSDs, 3× replication, CRUSH rule pinned to the NVMe device class, CephFS for ISOs, templates and snippets
- per-node ZFS on a fast secondary NVMe for local VM disks and off-Ceph backups
- an EVPN zone with four routed vnets, anycast gateways and SNAT exit on every node
- a cluster-wide firewall with a DROP default, enabled behind a dead-man switch
- HA (migrate on shutdown, static CRS) and nightly snapshot backups
- validation: cross-node overlay, SNAT egress, HA relocation, backup, and a reboot test

It also records the problems that came up and how they were fixed, so you don't hit them:
rate-adapting SFP-10G-T modules silently dropping corosync bursts, pmxcfs wedging after an
interrupted join, and a stray initramfs udevd breaking Ceph RBD containers.

## Status

| Part | State |
|---|---|
| Cluster recipes and `pvecb` | validated on PVE 9.2 / Ceph 19.2, 3-node HCI |
| Full-mesh topology | written, **untested** |
| Admin recipes | see `tested:` in each file |
| galley dashboard | MVP ([`dashboard/README.md`](dashboard/README.md)): fleet, guests, plans, audit; `--demo` mode |

## Credits

- [community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE) (MIT) provides the app catalog and installers used by `pve-app.sh`. They are fetched from upstream at run time and never vendored.
- Proxmox VE and Ceph are trademarks of their respective owners. This project is not affiliated with Proxmox Server Solutions GmbH.

## License

[MIT](LICENSE)
