---
id: admin/health-checks
title: Health and drift checks (pve-health.sh)
tested: "PVE 9.2 · Ceph 19.2 · 3-node HCI · 2026-11"
risk: low
runs_on: node
automated_by: scripts/pve-health.sh
---

# Health and drift checks

`scripts/pve-health.sh` is a read-only checker that encodes the failure modes this cookbook has
seen in the field. It needs no inventory and runs on any PVE node. Agents should run it before and
after every change and refuse to report success while it shows `CRIT`.

## Preconditions

- Run as root on a PVE node.

## Inputs

| Flag | Meaning |
|---|---|
| *(none)* | Human-readable output, node and cluster checks |
| `--json` | One JSON object per line: `{"node","level","check","message"}` |
| `--node-only` | Skip cluster-wide checks (use when looping over every node) |

Exit codes: `0` all OK, `1` at least one `WARN`, `2` at least one `CRIT`.

## Steps

1. Run on one node for cluster checks plus that node:

   ```bash
   scripts/pve-health.sh
   ```

2. Run node checks on every node:

   ```bash
   for n in pve1 pve2 pve3; do ssh root@$n 'bash -s -- --node-only' < scripts/pve-health.sh; done
   ```

3. Machine-readable, e.g. only problems:

   ```bash
   scripts/pve-health.sh --json | python3 -c 'import json,sys; [print(r) for r in map(json.loads, sys.stdin) if r["level"] in ("WARN","CRIT")]'
   ```

4. Schedule it (systemd timer, results in the journal; pair with [notifications](notifications.md)):

   ```bash
   install -m 0755 scripts/pve-health.sh /usr/local/sbin/pve-health
   cat >/etc/systemd/system/pve-health.service <<'EOF'
   [Unit]
   Description=pve-cookbook health checks
   [Service]
   Type=oneshot
   ExecStart=/usr/local/sbin/pve-health --node-only
   EOF
   cat >/etc/systemd/system/pve-health.timer <<'EOF'
   [Unit]
   Description=Run pve-health every 15 minutes
   [Timer]
   OnCalendar=*:0/15
   Persistent=true
   [Install]
   WantedBy=timers.target
   EOF
   systemctl daemon-reload && systemctl enable --now pve-health.timer
   ```

### Check reference

| Check | Level when failing | Meaning | Remediation |
|---|---|---|---|
| `pmxcfs` | CRIT | `/etc/pve` not writable within 5 s: no quorum or a wedged sync | [troubleshooting/pmxcfs-wedged](../troubleshooting/pmxcfs-wedged.md) |
| `time` | CRIT | Clock not NTP-synchronized | `systemctl restart chrony`; check `chronyc sources` |
| `repos` | WARN | Enterprise repo enabled without subscription (apt 401s) | `scripts/pvecb base-os` |
| `updates` | WARN | Packages upgradable | [rolling-updates](rolling-updates.md) |
| `kernel` | WARN | Newer kernel installed than running | Reboot via [rolling-updates](rolling-updates.md) |
| `flowcontrol` | WARN | Rate-adapting SFP-10G-T without pause frames: bursts drop on 1G ports | `ethtool -A <nic> rx on tx on`, persist (`scripts/pvecb network`) |
| `corosync` | INFO | Standalone node | none |
| `corosync-links` | WARN | Fewer than 2 corosync links per peer | Add a second link (`pvecm` / edit corosync.conf) |
| `corosync-retx` | CRIT | Many `Retransmit List` messages: packet loss on the cluster network | Find the loss (flow control, cabling, MTU) |
| `cert` | WARN | Node certificate missing or expiring in 30 days | `pvecm updatecerts --force` |
| `udev` | CRIT | Stray initramfs udevd: RBD maps return before symlinks exist, so container creation on Ceph fails | `kill <pid>`; [troubleshooting/stray-initramfs-udevd](../troubleshooting/stray-initramfs-udevd.md) |
| `ssh-fallback` | WARN | No `/root/.ssh/authorized_keys2`: key SSH breaks when pmxcfs is down | `scripts/pvecb cluster` |
| `rootfs` | WARN | Root filesystem ≥ 80% | Clean `/var/log`, old kernels, ISOs on `local` |
| `zfs` | CRIT | A pool not ONLINE | `zpool status -x` |
| `nvme-wear` | WARN | NVMe endurance ≥ 80% used | Plan a replacement |
| `quorum` | CRIT | Not quorate or missing votes | Bring nodes back; never `pvecm expected 1` casually |
| `ceph` | WARN/CRIT | `ceph health` not OK | `ceph health detail`; [storage-ceph-ops](storage-ceph-ops.md) |
| `ceph-osd` | CRIT | Not all OSDs up and in | `ceph osd tree` |
| `ceph-flags` | WARN | `noout`/`norebalance`/`nobackfill` left set | `ceph osd unset <flag>` |
| `storage` | WARN ≥ 80%, CRIT ≥ 90% or inactive | Storage fill or inactive storage | Expand, prune, investigate |
| `ha` | CRIT | HA quorum not OK | `ha-manager status` |
| `ha-resource` | CRIT | Resource in `error`/`fence` | `ha-manager status`; fix and `ha-manager set <sid> --state started` |
| `firewall` | WARN | Datacenter firewall disabled | [firewall](firewall.md) |
| `backup-coverage` | WARN | Guests (< 99000) in no enabled backup job | [backups-restore](backups-restore.md) |
| `backup-jobs` | WARN | No enabled backup jobs | [backups-restore](backups-restore.md) |
| `backup-result` | WARN | Last backup task for a guest failed | Read the task log |

## Verify

```bash
scripts/pve-health.sh; echo "exit=$?"            # 0 on a healthy cluster
```

## Rollback

Read-only; nothing to roll back. Remove the timer with `systemctl disable --now pve-health.timer`.

## Gotchas

- The script never blocks on a wedged pmxcfs; probes that touch `/etc/pve` run in the background with a deadline.
- VMIDs ≥ 99000 are reserved for tests and ignored by the backup checks.
- `updates` reflects the last `apt-get update`; the cache age is shown in the message.
