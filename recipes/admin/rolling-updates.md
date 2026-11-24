---
id: admin/rolling-updates
title: Rolling updates and reboots, one node at a time
tested: "PVE 9.2 · Ceph 19.2 · 3-node HCI · 2026-11 (single-node reboot with noout verified)"
risk: high
runs_on: operator
---

# Rolling updates

Patch and reboot every node without downtime for HA guests and without Ceph rebalancing. The rule
that matters: **one node at a time, and the cluster must be fully healthy before the next.**

## Preconditions

- `scripts/pve-health.sh` exits 0 or 1 (no CRIT) on every node.
- Ceph `HEALTH_OK` and all PGs `active+clean`: `ceph -s`
- Enough free RAM on the remaining nodes to hold the drained node's guests.
- Fresh backups of anything not on shared storage.

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `NODES` | Order to patch (put the current CRM master last) | `pve3 pve2 pve1` |

## Steps

For each node `$N`, in order:

1. Drain it (HA guests move; non-HA guests need manual migration or will be shut down):

   ```bash
   ha-manager crm-command node-maintenance enable $N
   pvenode migrateall <other-node> --vms "$(pvesh get /nodes/$N/qemu --output-format json | python3 -c 'import json,sys; print(",".join(str(v["vmid"]) for v in json.load(sys.stdin) if v["status"]=="running"))')"   # non-HA VMs, optional
   ```

2. Keep Ceph from rebalancing while the node's OSDs are down:

   ```bash
   ceph osd set-group noout $N          # or cluster-wide: ceph osd set noout
   ```

3. Update:

   ```bash
   ssh root@$N 'apt-get update && DEBIAN_FRONTEND=noninteractive apt-get -y -o Dpkg::Options::=--force-confold full-upgrade'
   ```

4. Reboot (only if a new kernel or the update requires it):

   ```bash
   ssh root@$N 'systemd-run --on-active=3 systemctl reboot'
   ```

5. Wait until it is really back. Do not trust "SSH answers": check uptime, quorum, pmxcfs and OSDs:

   ```bash
   until ssh -o ConnectTimeout=3 root@$N 'test $(cut -d. -f1 /proc/uptime) -lt 900 && systemctl is-active -q pve-cluster corosync'; do sleep 5; done
   ssh root@$N 'pvecm status | grep -q "Quorate: *Yes"'
   until ceph osd stat | grep -qE '([0-9]+) osds: \1 up'; do sleep 5; done
   ssh root@$N 'pgrep -a systemd-udevd'      # exactly ONE udevd; a second (initramfs) one breaks RBD
   ssh root@$N 'bash -s' < scripts/pve-health.sh --node-only
   ```

6. Re-enable and let Ceph settle:

   ```bash
   ceph osd unset-group noout $N         # or: ceph osd unset noout
   until ceph health | grep -q HEALTH_OK; do sleep 10; done
   ha-manager crm-command node-maintenance disable $N
   ```

7. Only now move to the next node.

## Verify

```bash
for n in pve1 pve2 pve3; do ssh root@$n 'echo "$(hostname) $(pveversion | cut -d/ -f2) $(uname -r)"'; done   # all identical
ceph -s | grep -E 'health|osd:'
ceph osd dump | grep '^flags'           # no noout left
ha-manager status                       # no node in maintenance
```

## Rollback

- Bad kernel: choose the previous kernel at boot, then pin it with `proxmox-boot-tool kernel pin <version>`.
- Bad package: `apt-get install <pkg>=<previous-version>` (see `/var/log/apt/history.log`).
- Abort mid-way: unset `noout` and disable maintenance mode on that node once it is back.

## Gotchas

- Rebooting a second node before the first has rejoined loses quorum on a 3-node cluster, and Ceph PGs go inactive.
- A reboot-wait loop that only checks "services active" can pass **before** the node has gone down. Always check uptime.
- After a reboot, look for a stray initramfs udevd (two `systemd-udevd` processes). It makes `rbd map` return early and breaks container creation on Ceph.
- Mixed versions are supported only during the rollout. Finish within the same maintenance window.
- Major upgrades (e.g. PVE 8 → 9) are different. Follow the official upgrade guide and run `pve8to9 --full` first.
