---
title: Protection
summary: See which guests are in a backup job, add unprotected guests to a job, and review each cluster's backup jobs.
order: 90
route: /protection
---

The **Protection** page answers one question: is every guest in a backup job? The **Protection** entry in the navigation shows a count when some guests are not.

## Backup coverage per cluster

The top of the page has one card per cluster:

- **All covered**, or **N unprotected**, and **N of M guests in a backup job**.
- **Unknown** when galley could not read the cluster's backup coverage, or the cluster is stale. galley never counts unknown coverage as covered.

Coverage is what PVE reports as "not backed up": guests that no enabled backup job selects. It says nothing about whether the last backup succeeded; check the job's tasks on the Activity page or in PVE.

Templates, and guests with VMIDs from 99000 up (a range reserved for tests), are not counted.

## Guests without a backup

**Guests without a backup** lists every guest no backup job selects, with its cluster and node. Select a guest's name to open it.

If the cluster has an enabled backup job, each row has a button such as **Add to nightly**. It adds the guest to the cluster's first enabled backup job.

### Add a guest to a backup job

1. On the **Protection** page, find the guest under **Guests without a backup**.
2. Select **Add to <job>**. The same fix is offered as **Review fix** on the **Backup coverage** widget and as a finding in **Needs attention** on the [Overview](overview.md).
3. Review the change in **Changes**:
   - For a job that backs up **all guests**, galley removes the guest from the job's exclude list (`pvesh set /cluster/backup/<job> --exclude …`).
   - For a job that lists guests, galley adds the guest's VMID to the list (`pvesh set /cluster/backup/<job> --vmid …`).
4. Apply the change.

The guest is backed up from the job's next scheduled run.

galley refuses the change, with the reason, when:

- the job selects guests by pool (add the guest to that pool instead);
- the job runs only on one node and the guest is on another;
- your PVE account cannot read the job.

If the job changed since the change was prepared, PVE rejects it; start it again. PVE checks your rights to change the job when the change runs; the [API explorer](api-explorer.md) shows the exact rule under **Permissions** for `PUT /cluster/backup/{id}`.

If a cluster has no enabled backup job, the row says **No automatic fix**.

## Backup jobs

**Backup jobs on <cluster>** lists each job: its ID, schedule, storage, mode (snapshot, suspend or stop), which guests it backs up (**all guests**, **all guests except …**, **guests …** or **pool …**), and whether it is **Enabled** or **Disabled**. You must be logged in to the cluster to see its jobs.

galley does not create backup jobs. Create one in the PVE interface under Datacenter, Backup, or with the [API explorer](api-explorer.md) (`POST /cluster/backup`).

## Related findings

**Needs attention** on the Overview also warns when a cluster has guests but no backup jobs at all ("no backup jobs configured").
