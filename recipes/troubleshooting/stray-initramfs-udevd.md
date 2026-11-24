---
id: troubleshooting/stray-initramfs-udevd
title: Stray initramfs udevd breaks Ceph RBD container creation
tested: "PVE 9.2 · systemd 257 · Ceph 19.2 · 2026-11 (reproduced and fixed)"
risk: low
runs_on: node
automated_by: scripts/pve-health.sh (check "udev")
---

# Stray initramfs udevd breaks Ceph RBD container creation

On one node only, every container create on Ceph RBD fails:

```text
The file /dev/rbd-pve/<fsid>/vm-pool/vm-NNN-disk-0 does not exist and no size was specified.
unable to create CT NNN - command 'mkfs.ext4 -O mmp -E 'root_owner=100000:100000' /dev/rbd-pve/…' failed: exit code 1
```

VMs and other nodes are fine. The cause is a second `systemd-udevd`, left over
from the initramfs, still running in `init.scope`. It announces device events
**before** any rules run. `rbd map` waits for the first announcement, returns, and
PVE runs `mkfs` before the real udevd has created `/dev/rbd-pve/...`.

## Preconditions

- Confirm the duplicate:

  ```bash
  pgrep -af udevd
  # e.g.  364 /usr/lib/systemd/systemd-udevd --daemon --resolve-names=never   <- stray
  #     408319 /usr/lib/systemd/systemd-udevd                                  <- real
  for p in $(pgrep -f systemd-udevd); do echo "$p $(cat /proc/$p/cgroup) $(readlink /proc/$p/exe)"; done
  # stray: 0::/init.scope   exe … (deleted)
  ```

- Or watch an event get announced twice:

  ```bash
  udevadm monitor --udev --subsystem-match=block &   # then: rbd map <pool>/<test-image>
  # UDEV add /devices/rbd/0/block/rbd0 appears twice, the first one ~1ms after KERNEL
  ```

## Inputs

None.

## Steps

1. Kill the stray. It's not the systemd-managed one, and nothing depends on it:

   ```bash
   kill <stray-pid>
   ```

2. Remove the root cause, which is usually a **stale duplicate LVM volume group**
   (for example an old Proxmox install, `pve-OLD-xxxx`, on a secondary disk) present at
   boot. Wipe it (the ceph and local-zfs steps do this) and reboot once so the
   initramfs comes up clean.

## Verify

```bash
pgrep -c systemd-udevd           # 1
img=t$$; rbd create vm-pool/$img --size 64M; dev=$(rbd map vm-pool/$img)
ls /dev/rbd-pve/*/vm-pool/$img && echo "symlink present at return"   # must be present immediately
rbd unmap $dev; rbd rm vm-pool/$img
scripts/pve-health.sh | grep udev   # OK single udevd
```

## Rollback

Not applicable. The stray process has no state.

## Gotchas

- **Restarting `systemd-udevd.service` doesn't fix it.** That only restarts the real one.
- **The same node passes `mkfs` by hand**, because by the time you type the command
  the symlink exists. It's a race, so test with the immediate `ls` above.
- **Prevent it**: wipe old OS installs from secondary disks *before* a node's first
  production boot, and reboot after wiping disks that held LVM.
