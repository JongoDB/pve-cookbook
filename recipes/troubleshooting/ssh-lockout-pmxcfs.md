---
id: troubleshooting/ssh-lockout-pmxcfs
title: Key-based SSH fails when pmxcfs is down (authorized_keys lives in /etc/pve)
tested: "PVE 9.2 · 2026-11 (reproduced and recovered)"
risk: medium
runs_on: node
automated_by: scripts/pvecb cluster (installs authorized_keys2)
---

# Key-based SSH fails when pmxcfs is down (authorized_keys lives in /etc/pve)

On a clustered PVE node, `/root/.ssh/authorized_keys` is a symlink to
`/etc/pve/priv/authorized_keys`. Stopping `pve-cluster` unmounts `/etc/pve`, which
makes the symlink dangle, so **every key login is refused**
(`Permission denied (publickey,password)`). A wedged pmxcfs can also make sshd
hang during auth: TCP connects, then nothing happens.

## Preconditions

- You're about to stop or restart `pve-cluster`, or you're already locked out.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| Node | The locked-out node | `pve3` |

## Steps

1. **Prevention (do this on every cluster).** Mirror the keys to a file sshd also reads:

   ```bash
   cat /etc/pve/priv/authorized_keys > /root/.ssh/authorized_keys2 && chmod 600 /root/.ssh/authorized_keys2
   sshd -T | grep authorizedkeysfile    # must list .ssh/authorized_keys2 (Debian default)
   ```

   `scripts/pvecb cluster` does this on every node. Re-run it after adding keys.

2. **Recovery when locked out.** Use the root password (the user has to type it):

   ```bash
   ssh -o PreferredAuthentications=password root@192.0.2.13 'systemctl start pve-cluster'
   ```

   Or use the console/IPMI, or reboot the node. `pve-cluster` starts at boot.

3. **Hung auth (pmxcfs wedged, not stopped)**: SSH to another node, isolate the
   stuck one from corosync so its pmxcfs goes read-only and readable, then log in.
   See [pmxcfs-wedged](pmxcfs-wedged.md) step 4.

## Verify

```bash
ls -la /root/.ssh/authorized_keys /root/.ssh/authorized_keys2
# with pve-cluster stopped on a test node, a key login still works
```

## Rollback

`rm /root/.ssh/authorized_keys2` (not recommended).

## Gotchas

- **`authorized_keys2` goes stale** when you add keys through the GUI or
  `/etc/pve/priv/authorized_keys`. Refresh it with step 1 or `pvecb cluster`.
- **Automation tip:** always pass `-o ConnectTimeout=… -o ServerAliveInterval=…`, so a
  wedged sshd fails fast instead of hanging your agent.
