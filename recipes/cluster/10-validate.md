---
id: cluster/10-validate
title: Validate — health checks and end-to-end smoke test
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: low
runs_on: operator
automated_by: scripts/pvecb validate
---

# Validate — health checks and end-to-end smoke test

Prove the whole stack works before anyone puts workloads on it. Validation has two parts:

1. **Health:** `scripts/pve-health.sh` runs on every node. It checks pmxcfs, quorum,
   corosync links and retransmits, Ceph, storage, HA, firewall, certificates,
   updates, NTP, NVMe wear, flow control, stray udevd, and backup coverage.
2. **Smoke test:** two throwaway containers (IDs **99901/99902**) on different nodes
   share an EVPN vnet. The test checks cross-node overlay traffic, the anycast
   gateway, SNAT egress, the full MTU path, an HA relocation and a snapshot backup.
   The containers are always cleaned up.

The final check is a reboot test: reboot one node and confirm everything comes back
without help.

## Preconditions

- All previous cluster steps complete.
- IDs 99901 and 99902 are free. The 99000+ range is reserved for tests.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `sdn.evpn.vnets[0]` | vnet used for the smoke test | `servers` |
| `storage.ceph.pool` | Disk storage for the test CTs | `vm-pool` |
| `backups.storage` | Backup target exercised | `backup-local` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb validate
   ```

2. Manual health check on any node:

   ```bash
   scripts/pve-health.sh            # human output; exit 0 OK, 1 warn, 2 critical
   scripts/pve-health.sh --json     # one JSON object per check
   ```

3. Reboot test, one node at a time:

   ```bash
   ceph osd set noout
   ssh root@pve3 'systemd-run --on-active=2 systemctl reboot'
   # wait for a FRESH boot (uptime small) AND services up — services may still look
   # healthy for a few seconds before the reboot actually starts:
   until ssh root@pve3 'test $(cut -d. -f1 /proc/uptime) -lt 900 && systemctl is-active -q pve-cluster ceph-osd.target frr'; do sleep 5; done
   ceph osd unset noout
   ssh root@pve3 'ethtool -a nic0; zpool list; pve-firewall status; vtysh -c "show bgp summary"'
   ```

## Verify

- `pvecb validate` prints `✓ cross-node overlay`, `✓ internet via SNAT exit`,
  `✓ HA relocate … in Ns`, `✓ snapshot backup`, and ends with `✓ [validate] done`.
- After the reboot test, the node has flow control on, its ZFS pool ONLINE, the
  firewall running, BGP Established, corosync with 2 links, Ceph HEALTH_OK, and CephFS mounted
  (`findmnt /mnt/pve/cephfs`). CephFS can take 10–30 s after boot to show active.

## Rollback

Nothing persists. If a run was interrupted, clean up by hand:
`ha-manager remove ct:99902; pct destroy 99901 --purge 1; pct destroy 99902 --purge 1`.

## Gotchas

- **Reference timings** on a 1G shared backend: HA relocation of a small CT took about 38 s,
  and a snapshot backup of a 2 GB CT about 13 s.
- **A wait loop that checks only "service active"** can pass *before* the reboot
  starts. Always pair it with an uptime check.
- **`CRIT udev`** means a stray initramfs udevd. Fix it before trusting RBD. See
  [stray-initramfs-udevd](../troubleshooting/stray-initramfs-udevd.md).
