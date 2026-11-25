---
title: Guests
summary: Find VMs and containers, act on one or many, and change their hardware and options.
order: 50
route: /guests
---

The **Guests** page lists every VM and container you can see, across all clusters. Select a guest's name to open its detail page.

## Find guests

- **Search name, VMID, tag or node** filters as you type. The search is kept in the address, so you can bookmark or share a filtered list.
- **Cluster** (shown with more than one cluster), **Status** (**Running**, **Stopped**, **Paused**) and **Type** (**VMs**, **Containers**) narrow the list further.
- Select a tag in the **Tags** column to filter by it.
- An **HA** badge next to a name means the guest is managed by PVE high availability. Hover over it to see the HA state.

Templates are not listed.

The list shows VMID, name, type, cluster, node, status, CPU, memory, uptime and tags. It updates live.

## Act on several guests at once

1. Tick the guests, or tick the box in the header to select all guests shown.
2. Choose an action in the toolbar: **Start**, **Shut down**, **Reboot**, **Stop**, **Snapshot**, **Migrate** or **Destroy**.
3. For **Snapshot**, enter a **Snapshot name** and select **Review snapshot**. For **Migrate**, choose a **Target node** and select **Review migration**.
4. Review the change in **Changes** and apply it. See [How changes work](changes.md).

The toolbar works on guests of one cluster at a time. If the buttons are unavailable, the reason is shown: **Select guests first**, **Select guests from one cluster at a time**, or **Log in to <cluster> first**.

For a migration of several guests, **Target node** offers only nodes that can take every selected guest. Running VMs move live; running containers restart on the target.

## The guest page

The top of a guest's page shows its status, type, node, cluster, uptime, HA state and tags, and the action buttons.

The tabs are **Summary**, **Hardware**, **Options**, **Snapshots** and **Task history**.

### Summary

Current CPU, memory, boot or root disk, node, uptime and high availability state, and history charts for **CPU**, **Memory used**, **Network** and **Disk I/O**. Choose the time range above the charts.

### Task history

The guest's PVE tasks on its current node, newest first (up to 50): start time, task, duration, user and result. Tasks that ran while the guest was on another node stay in that node's log.

## Start, shut down, reboot or stop a guest

1. Open the guest.
2. Select **Start** (when it is not running), or **Shut down**, **Reboot** or **Stop** (when it is running).
3. Apply the change in **Changes**.

- **Shut down** asks the guest's operating system to shut down cleanly (`qm shutdown` or `pct shutdown`).
- **Stop** is a hard power-off (`qm stop` or `pct stop`). Unsaved data in the guest may be lost.

You need `VM.PowerMgmt` on the guest.

## Migrate a guest

1. Open the guest and select **Migrate**.
2. Under **Move <guest> from <node> to**, choose the target node. Only other online nodes are offered.
3. Select **Review migration**, then apply the change.

- A running VM migrates live (`qm migrate <vmid> <node> --online`) and keeps running.
- A stopped VM moves offline.
- A running container restarts on the target node (`pct migrate <vmid> <node> --restart`).

You need `VM.Migrate` on the guest. A VM with a raw PCI device (not a PCI mapping) cannot move; see [Hardware and GPUs](hardware-and-gpus.md).

## Take a snapshot

1. Open the guest and select **Snapshot**, or go to the **Snapshots** tab and select **Take snapshot**.
2. Enter a **Snapshot name**: it starts with a letter, then 1 to 39 letters, digits, `-` or `_`. For example `pre-upgrade`.
3. Optionally, enter a **Description**.
4. Select **Review snapshot**, then apply the change.

Snapshots need storage that supports them, such as Ceph RBD, ZFS, LVM-thin or qcow2 files. You need `VM.Snapshot` on the guest.

The **Snapshots** tab shows the snapshot tree with each snapshot's parent, description and time. **Now (current state)** marks where the guest is. **Includes RAM** marks snapshots that saved the VM's memory.

To roll back or delete a snapshot, use the [API explorer](api-explorer.md) (`POST /nodes/{node}/qemu/{vmid}/snapshot/{snapname}/rollback`, or `DELETE /nodes/{node}/qemu/{vmid}/snapshot/{snapname}`; use `lxc` instead of `qemu` for containers), or ask the [assistant](assistant.md) to draft it. A rollback is destructive and asks for typed confirmation.

## Destroy a guest

1. Open the guest and select **Destroy**, or select it on the Guests page and select **Destroy** in the toolbar.
2. In **Changes**, read the steps. A running guest is stopped first.
3. Type `destroy <vmid>` and select **Apply change**.

Destroy permanently deletes the guest and all its disks, and removes it from backup jobs and HA (`qm destroy <vmid> --purge 1 --destroy-unreferenced-disks 1`). Existing backups are kept. You need `VM.Allocate` on the guest.

## Change hardware

The **Hardware** tab lists processors, memory, swap (containers), machine and firmware (VMs), SCSI controller, disks, network devices and PCI devices.

To change one item:

1. Select **Edit** on its row. A form opens with that item's settings, filled in with the current values.
2. Change the values. See [The resource editor](#the-resource-editor).
3. Select **Review change**, then apply it in **Changes**.

To add a device:

1. Select **Add device**.
2. For a VM, choose **Network device**, **Disk** or **PCI device or GPU**. For a container, choose **Network device**, **Mount point** or **Device**.
3. galley picks the next free slot (for example `net1` or `scsi2`). Fill in the fields.
4. Select **Review change**, then apply it.

Some changes to a running VM take effect only after the VM restarts. You need `VM.Config.*` privileges on the guest for the kind of setting you change (for example `VM.Config.Memory` or `VM.Config.Network`).

For GPUs, read [Hardware and GPUs](hardware-and-gpus.md) first.

## Change options

The **Options** tab lists every other setting in the guest's configuration. Select **Edit options** to edit them in the resource editor, and **Close editor** to close it.

## The resource editor

The same form is used on the Hardware and Options tabs, on the Hardware page and in the API explorer. It is built from the cluster's own API schema, so it offers exactly the settings your PVE version supports.

- Each field shows the setting's name, whether it is **required**, and PVE's description. New settings are marked **New**.
- Settings made of several parts, such as `virtio,bridge=vmbr0,tag=20`, are shown as one small field per part. **Edit as text** switches to the raw value; **Edit as fields** switches back.
- **Remove** removes a setting; it is then marked **Removed**, and **Keep** undoes that. **Use default** removes a setting so that PVE uses its default.
- Buttons such as **Add net device** or **Add scsi disk** add the next free slot of that kind. **Add a setting** adds any other setting.
- **Preview** shows the `pvesh` command the change will run.
- Only what you changed is sent. Removed settings are sent as `delete`, so the change asks for typed confirmation.
- If someone else changed the configuration in the meantime, PVE rejects the change (galley sends the configuration's digest). Open the editor again to start from the current values.
- If a value is invalid, the form says which fields to fix. If you changed nothing, it says **Nothing changed yet.**

Select **Review change** to open the change in **Changes**. Nothing runs until you apply it.

## Open a console

Select **Console** on a running guest. See [Consoles](consoles.md).

## Use the command palette

You can also act on a guest from the command palette, for example `start 120`, `migrate web03 pve2` or `snapshot 120 pre-upgrade`. See [Keyboard and search](keyboard-and-search.md).
