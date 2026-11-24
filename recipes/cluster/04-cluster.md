---
id: cluster/04-cluster
title: Create the cluster and join nodes
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: high
runs_on: operator
automated_by: scripts/pvecb cluster
---

# Create the cluster and join nodes

Create the cluster on the founder with two corosync links (backend first, mgmt as
fallback), then join the other nodes **one at a time**. Wait until pmxcfs is
writable everywhere after every join. Finally, install an SSH key fallback that does
not depend on pmxcfs.

## Preconditions

- Backend network up and every node pair reachable on both subnets.
- Joining nodes have **no guests** (`qm list` and `pct list` are empty) and are not in another cluster.
- Every node runs the same `pveversion`.
- The uplink passes bursts without loss (see [03-network-backend](03-network-backend.md) Verify).

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `cluster.name` | Corosync cluster name, ≤15 chars | `pve-lab` |
| `cluster.founder` | Creates the cluster | `pve1` |
| `corosync.links` | Link order; first gets highest priority | `[backend, mgmt]` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb cluster
   ```

2. Manual equivalent:

   ```bash
   # on the founder
   pvecm create pve-lab --link0 address=10.15.15.11,priority=20 --link1 address=192.0.2.11,priority=10

   # wait until pmxcfs accepts writes (do not use plain `timeout touch`: it can hang in D state)
   ( touch /etc/pve/.wt && rm /etc/pve/.wt ) & sleep 5; kill -0 $! 2>/dev/null && echo "STILL BLOCKED"

   # for EACH joining node, one at a time:
   #   1) trust its root key on the founder (cluster-wide authorized_keys)
   ssh root@pve2 'cat /root/.ssh/id_ed25519.pub || (ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519 && cat /root/.ssh/id_ed25519.pub)' \
     | ssh root@pve1 'cat >> /etc/pve/priv/authorized_keys'
   ssh root@pve2 'ssh -o StrictHostKeyChecking=accept-new root@192.0.2.11 true'
   #   2) join — let it finish, never interrupt it
   ssh root@pve2 'pvecm add 192.0.2.11 --use_ssh --link0 address=10.15.15.12,priority=20 --link1 address=192.0.2.12,priority=10'
   #   3) wait for pmxcfs to be writable on ALL members before the next join
   #   4) make sure the node certificate exists
   ssh root@pve2 'test -f /etc/pve/local/pve-ssl.pem || pvecm updatecerts --force; systemctl reload-or-restart pveproxy'

   # finally: SSH key fallback independent of pmxcfs, on every node
   for n in pve1 pve2 pve3; do
     ssh root@pve1 'cat /etc/pve/priv/authorized_keys' | ssh root@$n 'cat > /root/.ssh/authorized_keys2; chmod 600 /root/.ssh/authorized_keys2'
   done
   ```

## Verify

```bash
pvecm status | grep -E 'Quorate|Total votes'   # Quorate: Yes, votes = node count
corosync-cfgtool -n                             # every peer: 2 links "enabled connected"
journalctl -u corosync --since -10min | grep -c 'Retransmit List'   # 0 (or a handful)
ls /etc/pve/nodes/*/pve-ssl.pem                 # one per node
sshd -T | grep authorizedkeysfile               # includes .ssh/authorized_keys2
```

## Rollback

Removing a node is destructive and the node must be reinstalled afterwards:

```bash
# on a remaining node, with the departing node powered off:
pvecm delnode pve3
```

To undo a fresh one-node cluster on the founder (no guests), follow the "Separate a
node without reinstalling" procedure in the PVE admin guide. Reinstalling is simpler.

## Gotchas

- **`pvecm add` hung or was killed.** All nodes show quorum, but writes to `/etc/pve`
  hang and the logs say `ignore sync request from wrong member`. Fix it with
  [pmxcfs-wedged](../troubleshooting/pmxcfs-wedged.md). Don't start another join first.
- **`echo … >> /root/.ssh/authorized_keys` gives "Permission denied"** right after
  `pvecm create`: the file is a symlink into `/etc/pve`, and pmxcfs was restarting.
  Wait for writability and retry.
- **Plain `ssh pve2` from a node fails host-key verification on PVE 9.** That's
  expected: PVE pins host keys per node. Test the way PVE connects:
  `ssh -o HostKeyAlias=pve2 -o UserKnownHostsFile=/etc/pve/nodes/pve2/ssh_known_hosts root@pve2 true`.
- **Stopping `pve-cluster` on a node you reach by key** locks you out, because
  `authorized_keys` disappears with `/etc/pve`. The `authorized_keys2` fallback above
  prevents this. See [ssh-lockout-pmxcfs](../troubleshooting/ssh-lockout-pmxcfs.md).
- **Persistent `Retransmit List` lines** mean packet loss on a corosync link,
  usually microbursts on a rate-adapting transceiver. Fix the network before going further.
