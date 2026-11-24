---
id: troubleshooting/pmxcfs-wedged
title: pmxcfs wedged — /etc/pve writes hang while the cluster looks quorate
tested: "PVE 9.2 · corosync 3.2 · knet 1.36 · 2026-11 (reproduced and fixed on a 3-node cluster)"
risk: high
runs_on: node
automated_by: none
---

# pmxcfs wedged — /etc/pve writes hang while the cluster looks quorate

Corosync reports quorum, but any write to `/etc/pve` blocks forever. That includes
`touch`, `pvesh` and GUI changes. Processes pile up in `D` state, and `pvestatd`
and `pvescheduler` freeze. Usually pmxcfs's internal sync (DFSM) stalled because
corosync messages got lost: membership changed during the sync, or one link drops bursts.

## Preconditions

- Symptoms match, on one or more nodes:

  ```bash
  ps -eo stat,etime,cmd | awk '$1 ~ /^D/'        # pvestatd / pvescheduler / touch in D state
  journalctl -u pve-cluster --since -30min | grep -E 'wrong member|waiting for updates'
  journalctl -u corosync --since -10min | grep -c 'Retransmit List'   # large and repeating
  ```

- **Before stopping pve-cluster anywhere**, make sure you can still SSH in without
  `/etc/pve`: `/root/.ssh/authorized_keys2` exists, or you know the root password
  or have console access. See [ssh-lockout-pmxcfs](ssh-lockout-pmxcfs.md).

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| Node list | All cluster members | `pve1 pve2 pve3` |

## Steps

1. **Probe without hanging yourself.** Never run a bare `touch /etc/pve/x` from
   automation. Background it instead:

   ```bash
   ( touch /etc/pve/.wt && rm /etc/pve/.wt ) & p=$!; sleep 5; kill -0 $p 2>/dev/null && echo WEDGED || echo OK
   ```

2. **Find the lossy path.** Compare knet counters for the same peer on sender and receiver:

   ```bash
   corosync-cmapctl -m stats | grep -E 'knet\.node[0-9]+\.link0\.(tx|rx)_data_packets'
   corosync-cmapctl -m stats | grep -E 'srp\.mcast_retx'   # one node much higher = it keeps resending
   ```

   Then confirm on the wire with simultaneous captures (10 s window):

   ```bash
   # on the sender (pve2)
   timeout 10 tcpdump -i vmbr0 -nn -q 'udp and src 10.15.15.12 and dst 10.15.15.11' | wc -l
   # on the receiver (pve1), same window
   timeout 10 tcpdump -i nic0 -nn -q 'udp and src 10.15.15.12' | wc -l
   ```

   Sent ≫ received means real packet loss. On rate-adapting SFP-10G-T modules this
   is microburst loss; fix it with [sfp-10g-t-flow-control](sfp-10g-t-flow-control.md)
   **first**. Otherwise the wedge comes straight back.

3. **Reset the whole ring at once** (no guests at risk on a fresh cluster; with
   guests, HA may fence. Put HA resources in `ignored` state first):

   ```bash
   for n in pve1 pve2 pve3; do ssh root@$n 'systemctl stop pve-cluster corosync' & done; wait
   for n in pve1 pve2 pve3; do ssh root@$n 'systemctl start corosync' & done; wait
   # wait for "Total votes: 3" on one node, then:
   for n in pve1 pve2 pve3; do ssh root@$n 'systemctl start pve-cluster' & done; wait
   ```

4. **If one node keeps poisoning the sync**, isolate it so the others can form a clean
   2-node majority:

   ```bash
   # on every OTHER node
   for ip in 10.15.15.13 192.0.2.13; do
     iptables -I INPUT  -s $ip -p udp --dport 5405:5412 -j DROP
     iptables -I OUTPUT -d $ip -p udp --dport 5405:5412 -j DROP
   done
   systemctl restart pve-cluster      # on the majority nodes
   # on the isolated node: it becomes read-only but readable (SSH by key works again)
   # fix it, then remove the rules (iptables -D … same args) and restart corosync + pve-cluster there
   ```

## Verify

```bash
( touch /etc/pve/.wt && rm /etc/pve/.wt ) & sleep 3; kill -0 $! 2>/dev/null || echo writable   # every node
journalctl -u pve-cluster --since -3min | grep -E 'all data is up to date|synced members'
journalctl -u corosync --since -1min | grep -c 'Retransmit List'   # 0
ps -eo stat | grep -c '^D'                                           # 0
```

## Rollback

The steps are restarts and temporary iptables rules. Remove any `-I` rules you added with the matching `-D`.

## Gotchas

- **Restarting only one node doesn't help** while a lossy link is still dropping messages.
- **`timeout` doesn't save you from D state.** Processes blocked in FUSE ignore SIGKILL.
- **`pvesh get /cluster/status` hangs too** while wedged. Read logs and `corosync-*`
  tools instead, since they don't touch `/etc/pve`.
- **Database versions diverging** (`sqlite3 -readonly /var/lib/pve-cluster/config.db 'select max(version) from tree'`)
  between nodes is normal while wedged. The node that's behind waits for the leader's updates.
