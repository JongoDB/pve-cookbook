# Worked example: 3-node hyperconverged cluster

A real build of the [three-node-hci](../../recipes/topologies/three-node-hci.md)
topology, condensed from the operator session. Names and addresses are generic.
Hardware, decisions, incidents and timings are as they happened.

## Hardware

| Item | Per node |
|---|---|
| Chassis | 1U edge server |
| CPU | Xeon D, 20 cores / 40 threads |
| RAM | 512 GB |
| Boot | M.2 boot-optimised NVMe module (~450 GB, LVM) |
| Data | 3 × M.2 NVMe 3.84 TB read-intensive → Ceph OSDs |
| Fast local | 1 × M.2 NVMe 800 GB mixed-use → ZFS `nvme-local` |
| Network | 4 × SFP28 (Intel E823, `ice` driver); **only nic0 cabled**, using an SFP-10G-T copper module into an unmanaged **1G** switch |

Starting state: PVE 9.2 freshly installed. The data disks still held an empty
ZFS pool, old VMFS datastores and an old Proxmox install on the 800 GB disk. The
enterprise repo was enabled without a subscription, so apt returned 401.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Shared storage | Ceph squid, 9 OSDs, `size 3 / min_size 2`, NVMe CRUSH rule | 3 identical nodes; tolerates one node down |
| Backend network | `shared-bridge` on `10.15.15.0/24` now, full mesh later | Only one cable per node today; same IPs move to the mesh |
| Corosync | link0 backend (prio 20), link1 mgmt (prio 10) | Two links; becomes truly redundant once the mesh exists |
| 800 GB disks | ZFS `local-zfs` + `backup-local` (500 G quota) | Fast local tier, plus backups that live off Ceph |
| SDN | EVPN, 4 vnets (servers/dmz/lab/infra), SNAT on all exit nodes | Works over L3 through a dumb switch; overlay follows guests |
| Firewall | DC firewall, DROP inbound, admin LAN in `management` | Enabled under a dead-man switch |
| HA/CRS | `shutdown_policy=migrate`, `crs ha=static`, rebalance on start | Planned reboots drain HA guests automatically |
| Backups | Nightly 01:30 snapshot, zstd, keep 3/7/4/3 | Off-cluster PBS recommended in addition |

## Timeline and incidents

1. **Discovery** (read-only), then **base OS**. Switched to no-subscription repos,
   ran a full upgrade (a new kernel arrived) and rebooted all nodes before clustering.
2. **Wiped 12 disks** (9 OSD + 3 fast) after explicit owner approval. The boot disk
   was guarded by matching against the `/boot/efi` parent device.
3. **Cluster create + joins.**
   - *Incident 1:* the first joins failed. `authorized_keys` couldn't be written
     because `/etc/pve` was restarting after `pvecm create`. Fixed by waiting for
     writability, which the cluster step now does.
   - *Incident 2:* the third join hung, and the automation killed it. From then on,
     `/etc/pve` writes hung on **every** node, and the logs said `ignore sync request
     from wrong member`. Restarting services on two nodes didn't help.
   - *Incident 3:* stopping `pve-cluster` on the hung node locked out key SSH,
     because `authorized_keys` lives in `/etc/pve`. It was recovered with a password
     login, and `authorized_keys2` was added on every node afterwards.
   - **Root cause:** knet counters showed one node retransmitting endlessly. tcpdump
     showed 1589 packets sent to a peer and **631 received**. The nodes used SFP-10G-T
     modules rate-adapting into a 1G switch, with flow control off. Pings and paced
     iperf looked clean (0–0.07% loss), but bursts didn't survive. `ethtool -A nic0 rx on tx on`
     brought the same capture to 38 sent and 38 received. After a full corosync and
     pve-cluster reset on all nodes, the cluster synced. See
     [sfp-10g-t-flow-control](../../recipes/troubleshooting/sfp-10g-t-flow-control.md).
4. **Ceph:** 3 mons, 3 mgrs, 9 OSDs (31 TiB raw, about 10.7 TB usable), RBD pool,
   CephFS with standby-replay. Because the effective link was 1G, recovery was
   throttled (`high_client_ops`, backfills 1).
5. **ZFS, SDN, firewall, datacenter**: all first-try. The firewall went in under the dead-man switch.
6. **Validation:** CTs on two nodes over the `servers` vnet. Cross-node ping 0% loss,
   SNAT egress OK, full 1450 MTU path OK, HA relocation **38 s**, snapshot backup of a
   ~200 MB archive in **13 s**. A reboot test of one node came back with everything up;
   CephFS took a few extra seconds to mount.
7. **A day later**, two latent bugs surfaced:
   - **Containers on Ceph RBD failed on one node** (`mkfs.ext4 … does not exist`). The
     cause was a stray initramfs udevd that had survived because the old Proxmox
     LVM volume group was present at that node's boot. Killing it fixed the node. See
     [stray-initramfs-udevd](../../recipes/troubleshooting/stray-initramfs-udevd.md).
   - **Containers on `local-zfs` failed everywhere** (`no mountpoint set`). The
     `vmdata` dataset had inherited `mountpoint=none`. Fixed in the local-zfs step,
     which repairs the layout in place.

## Condensed command transcript

```bash
cp inventory.example.yaml inventory.yaml      # edit names/IPs/disk matches
scripts/pvecb preflight
scripts/pvecb base-os                         # then reboot nodes with a new kernel
scripts/pvecb network                         # backend IPs + flow control
scripts/pvecb cluster                         # create on pve1, join pve2, pve3 one at a time
# storage.wipe_confirm: true in inventory, after confirming the disks hold nothing needed
scripts/pvecb --yes ceph local-zfs
scripts/pvecb sdn firewall datacenter
scripts/pvecb validate
# reboot test
ceph osd set noout; ssh root@pve3 'systemctl reboot'   # wait for fresh uptime + services
ceph osd unset noout; scripts/pve-health.sh
```

## Lessons

- Measure the uplink with **bursts** (`ping -f -s 1400`, or tcpdump counts on both
  ends), not just ping or paced iperf.
- Join nodes **one at a time** and wait for `/etc/pve` to be writable on every member between joins.
- Install `authorized_keys2` before you ever restart `pve-cluster`.
- Wipe old installs on secondary disks **before** the node's first production boot.
- Test containers on **every** storage, not just VMs. Mountpoints and udev races only show up there.

The inventory used is [inventory.yaml](inventory.yaml).
