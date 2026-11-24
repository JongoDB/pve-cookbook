---
id: admin/backups-restore
title: Backups, retention and tested restores
tested: "PVE 9.2 · vzdump to node-local ZFS dir · 2026-11 (job + snapshot backup verified; PBS untested)"
risk: medium
runs_on: node
automated_by: scripts/pvecb datacenter
---

# Backups, retention and tested restores

A backup you have not restored is a hope, not a backup. This recipe defines scheduled `vzdump` jobs,
retention, notes, and a restore drill to a throwaway VMID. It also shows how to prove that no guest is
left unprotected.

**Where backups live:**

- `backup-local` (node-local ZFS) survives Ceph failure and operator error, but not loss of the node.
- **Proxmox Backup Server (PBS) off the cluster** is the real answer: deduplication, incrementals,
  encryption, verification, file-level restore, offsite sync. Treat node-local backups as the fast tier.
- Never back up to `cephfs`/`vm-pool`; that is the same failure domain as the guests.

## Preconditions

- Backup storage active on every node: `pvesm status --content backup`
- Enough free space: `pvesm status --content backup | awk 'NR>1{print $1, $6"%"}'`

## Inputs

| Variable | Meaning | Example |
|---|---|---|
| `SCHEDULE` | systemd calendar event | `01:30`, `mon..fri 22:00`, `*-*-* 00/6:00` |
| `STORAGE` | backup target | `backup-local` or `pbs` |
| `RETENTION` | prune policy | `keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=3` |

## Steps

### 1. Nightly job for all guests

```bash
pvesh create /cluster/backup --id nightly-all --schedule '01:30' --storage backup-local \
  --all 1 --mode snapshot --compress zstd --zstd 4 --enabled 1 --repeat-missed 1 \
  --notes-template '{{guestname}} on {{node}}' --prune-backups 'keep-last=3,keep-daily=7,keep-weekly=4,keep-monthly=3' \
  --fleecing enabled=1,storage=local-zfs --comment 'Nightly snapshot backup of all guests'
```

`--fleecing` buffers guest writes on fast local storage during the backup, so a slow target cannot stall VM IO.
`--all 1` automatically includes guests created later. Exclude with `--exclude 9000,9001`.

### 2. Add Proxmox Backup Server (recommended)

```bash
pvesm add pbs pbs --server pbs.example.internal --datastore main --username backup@pbs \
  --password '<secret>' --fingerprint '<sha256 from PBS dashboard>' --content backup \
  --encryption-key autogen          # store /etc/pve/priv/storage/pbs.enc OFF the cluster too
pvesh set /cluster/backup/nightly-all --storage pbs
```

Run prune, GC and verify jobs on the PBS side and sync to a second PBS offsite.

### 3. Ad-hoc backup before risky changes

```bash
vzdump 120 --storage backup-local --mode snapshot --compress zstd --notes-template 'pre-upgrade {{guestname}}'
```

### 4. Restore drill (to a NEW id — never overwrite the original)

```bash
pvesm list backup-local --vmid 120 | tail -1                     # newest archive volid
qmrestore backup-local:backup/vzdump-qemu-120-<ts>.vma.zst 99120 --storage vm-pool --unique 1
qm set 99120 --net0 virtio,bridge=lab,link_down=1                 # isolate: no IP conflict with the original
qm start 99120 && qm status 99120
# containers:
pct restore 99110 backup-local:backup/vzdump-lxc-110-<ts>.tar.zst --storage vm-pool --unique 1
pct set 99110 --net0 name=eth0,bridge=lab,link_down=1 && pct start 99110 && pct exec 99110 -- systemctl is-system-running
# clean up
qm stop 99120 && qm destroy 99120 --purge 1; pct stop 99110 && pct destroy 99110 --purge 1
```

`--unique 1` regenerates MAC addresses so the clone cannot collide with the original.

### 5. File-level restore

- From PBS: GUI → storage → backup → *File Restore*, or `proxmox-backup-client` from any Linux host.
- From `vzdump` archives: restore to a temporary ID (step 4) and copy files out, or extract an LXC
  `tar.zst` directly: `zstd -dc vzdump-lxc-110-*.tar.zst | tar -x ./etc/nginx`.

## Verify

```bash
pvesh get /cluster/backup --output-format json-pretty
# guests not covered by any enabled job (should be empty):
pvesh get /cluster/backup-info/not-backed-up --output-format json
# last results
pvesh get /cluster/tasks --output-format json | python3 -c 'import json,sys; [print(t["id"], t["status"]) for t in json.load(sys.stdin) if t["type"]=="vzdump"][:20]'
scripts/pve-health.sh | grep -E 'backup-'
```

## Rollback

```bash
pvesh delete /cluster/backup/nightly-all
pvesm remove pbs
```

Deleting a job does not delete existing archives; prune them with `pvesm prune-backups <storage> --keep-last N`.

## Gotchas

- `snapshot` mode on VMs needs the QEMU guest agent for consistent filesystems (`--agent 1` plus the agent inside the guest).
- LXC snapshot mode needs snapshot-capable storage (ZFS, Ceph RBD). Otherwise vzdump falls back to `suspend`.
- Restoring over the original ID destroys the current guest. Always restore to a new ID first.
- Retention set on the job overrides the storage's `prune-backups`.
- A guest with a passthrough device backs up its disks but not device state.
- Node-local backup storage means a guest's backups are on the node where the job ran. After migration, new backups land on the new node.
