# AGENTS.md — operating guide for AI agents

This repository is a cookbook for building and running Proxmox VE clusters. It is
written to be executed by agents. Read this file first, then only the recipes you need.

## Golden rules

1. **Preflight before change.** Run `scripts/pvecb preflight` (or the recipe's Preconditions)
   and stop on any failure. Never guess hardware, disks, or IPs — read them from the node.
2. **One change at a time, verify after each.** Every recipe has a **Verify** section. Do not
   report success until it passes. If it fails, follow **Gotchas**, then **Rollback**.
3. **Destructive actions need explicit human consent.** Wiping disks, destroying guests,
   removing nodes, or enabling a DROP firewall policy: confirm with the human first,
   even if the inventory allows it. `storage.wipe_confirm: true` + `--yes` is the mechanical gate.
4. **Never interrupt a cluster join or a pmxcfs operation.** If a command hangs, diagnose
   read-only (logs, `corosync-cfgtool -n`) before killing anything. See
   `recipes/troubleshooting/pmxcfs-wedged.md`.
5. **Do not lock yourself out.** root's `authorized_keys` lives on pmxcfs. Ensure
   `/root/.ssh/authorized_keys2` exists before stopping `pve-cluster`. Arm a dead-man timer
   before enabling a firewall.
6. **Test guests use VMIDs 99000–99999** and must be destroyed afterwards.
7. **Probes that touch `/etc/pve` must be non-blocking** (background + poll). A wedged
   pmxcfs puts writers in uninterruptible sleep; `timeout` cannot kill them.
8. **Report faithfully.** Quote failing output. Say what you skipped.

## Where to start

| Task | Read |
|---|---|
| Build a new cluster from freshly installed PVE nodes | `recipes/cluster/00-overview.md`, then `recipes/topologies/*` |
| Add/replace storage, Ceph OSDs | `recipes/admin/storage-ceph-ops.md` |
| Create VMs/containers quickly | `recipes/admin/guests-vms-lxc.md`, `recipes/admin/helper-scripts.md` |
| Users, roles, API tokens, 2FA | `recipes/admin/users-roles-tokens.md` |
| Networks / SDN vnets | `recipes/admin/networks-sdn.md` |
| Firewall rules | `recipes/admin/firewall.md` |
| Backups and restore tests | `recipes/admin/backups-restore.md` |
| Is the cluster healthy? | `scripts/pve-health.sh` → `recipes/admin/health-checks.md` |
| Monitoring and alerting | `recipes/admin/monitoring.md`, `recipes/admin/notifications.md` |
| Patch the cluster | `recipes/admin/rolling-updates.md`, `recipes/admin/maintenance-mode.md` |
| Move guests between nodes or clusters | `recipes/admin/migration.md` |
| GPU / PCIe / USB passthrough, LLM servers | `recipes/admin/passthrough-gpu.md` |
| Something is broken | `recipes/troubleshooting/` |

## Tools in this repo

| Tool | Runs on | Purpose |
|---|---|---|
| `scripts/pvecb` | operator machine (bash ≥3.2, ssh, python3) | idempotent cluster build steps driven by `inventory.yaml` |
| `scripts/pve-health.sh` | any PVE node | read-only health & drift checks; `--json` for machines; exit 0/1/2 |
| `scripts/pve-app.sh` | any PVE node | unattended community-scripts deploys (LXC/VM catalog) |

`pvecb` supports `--dry-run` (prints mutating commands, still runs read-only probes) and
`-i <inventory>`. Steps: `pvecb list`.

## Inventory

`inventory.example.yaml` documents every key. Copy it to `inventory.yaml` (git-ignored).
Agents should fill it from facts gathered by `pvecb preflight`, then show it to the human
for approval before running mutating steps.

## Conventions

- Recipes follow `recipes/_TEMPLATE.md`: Preconditions → Inputs → Steps → Verify → Rollback → Gotchas.
- `tested:` front-matter states what a recipe was last validated on; `untested` means
  it has not been run on real hardware — proceed with extra verification.
- Commands assume PVE 9.x (Debian 13 "trixie") and Ceph Squid unless stated.
