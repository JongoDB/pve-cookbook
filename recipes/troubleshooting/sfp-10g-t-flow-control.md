---
id: troubleshooting/sfp-10g-t-flow-control
title: SFP-10G-T modules into 1G switches drop bursts — enable flow control
tested: "PVE 9.2 · Intel E823 (ice) · OEM SFP-10G-T · unmanaged 1G switch · 2026-11"
risk: low
runs_on: node
automated_by: scripts/pvecb network (network.flow_control: true)
---

# SFP-10G-T modules into 1G switches drop bursts — enable flow control

Copper 10GBASE-T SFP+ modules ("SFP-10G-T") run the host side at 10G and
rate-adapt the copper side down to 1G/2.5G/5G when the switch port is slower. They
buffer very little and depend on 802.3x **pause frames** to slow the NIC. With
flow control off (the default), any burst at 10G line rate overflows the module.

Ping and paced iperf look perfect. Corosync, pmxcfs sync, Ceph and migrations do
not, because they send in bursts. In the field we saw **~60% loss** of corosync
bursts on one path and 0.06% loss in iperf.

## Preconditions

- Identify the module and the real speed:

  ```bash
  ethtool -m nic0 | grep -E 'Vendor PN|Transceiver type'   # e.g. SFP-10G-T, "10G Base-SR"
  ethtool nic0 | grep Speed                                # says 10000Mb/s regardless
  ethtool -a nic0                                          # RX: off TX: off  <- the problem
  iperf3 -c <peer>                                          # ~940 Mbit/s => copper side is 1G
  ```

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `network.mgmt.uplink` | Port with the module | `nic0` |
| `network.flow_control` | Persist pause frames | `true` |

## Steps

1. Enable now:

   ```bash
   ethtool -A nic0 rx on tx on
   ```

2. Persist it in `/etc/network/interfaces` (the PVE GUI keeps `post-up` lines):

   ```text
   iface nic0 inet manual
       post-up /usr/sbin/ethtool -A nic0 rx on tx on || true
   ```

   Or set `network.flow_control: true` and run `scripts/pvecb network`.

3. Enable flow control on the switch port too if it's a managed switch. Unmanaged
   switches usually honour pause frames by default.

## Verify

Count the same corosync packets on sender and receiver over 10 s. The counts must match:

```bash
# sender
timeout 10 tcpdump -i vmbr0 -nn -q 'udp and src <me> and dst <peer>' | wc -l
# receiver
timeout 10 tcpdump -i nic0 -nn -q 'udp and src <sender>' | wc -l
journalctl -u corosync --since -5min | grep -c 'Retransmit List'   # 0
```

After a reboot: `ethtool -a nic0` still shows `RX: on TX: on`.

## Rollback

`ethtool -A nic0 rx off tx off` and remove the `post-up` line.

## Gotchas

- **Flow control is a workaround.** The real fix is matching speeds: put the module in
  a 10G port, or use SFP+ DACs or fibre. Treat the link as **1G** for capacity
  planning, including Ceph throttles and migration expectations.
- **`ping -f -s 1400`** is a better quick test than iperf. Corosync with a 50-message
  window is better still, so trust the tcpdump counts.
- **Symptom chain**: microburst loss → corosync `Retransmit List` → pmxcfs sync
  stalls → `/etc/pve` hangs. See [pmxcfs-wedged](pmxcfs-wedged.md).
