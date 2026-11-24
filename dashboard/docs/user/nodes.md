---
title: Nodes
summary: Check nodes across clusters, read a node's details, interfaces and disks, and open a node shell.
order: 70
route: /nodes
---

## The Nodes page

**Nodes** lists every node of every cluster: status, CPU, memory, number of guests, uptime, PVE version and kernel. With several clusters, filter with **Cluster**. Select a node's name to open its page.

A node's status is **online**, **offline**, or **unknown** when its cluster is stale. A stale cluster also shows a notice at the top, with the time of the last good data. See [Overview](overview.md#stale-and-unknown-data).

## A node's page

The top shows whether the node is online, its cluster and uptime, and the **Shell** button.

- **Facts**: CPU use and threads, load average, memory, swap, root file system, CPU model and sockets, kernel, PVE version, and boot mode (**UEFI** or **Legacy BIOS**, and **Secure Boot** if on).
- **History**: charts for **CPU**, **Memory used**, **Network** and **Pressure (PSI some, avg10)**. Choose the time range above them.
- **Guests on <node>**: the node's VMs and containers. Select one to open it.
- **Storage**: the storages this node uses, with used space, or **Disabled** or **Unavailable**.
- **Network interfaces**: each interface's name, type (with **inactive** and **VLAN aware** where they apply), address and gateway, and bridge ports or comment.
- **Disks**: each physical disk's device, model and serial, size, type, what uses it, SMART health and wear left.

Most of this is read live from PVE with your account. Listing disks needs `Sys.Audit` on `/nodes/<node>`; without it the page says **Disk list not available**.

The page is read-only. To change node settings, use the [API explorer](api-explorer.md) or the PVE interface. For what the API cannot do (NIC flow control, kernel parameters, packages), see [Host commands](hosts.md).

## Open a node shell

1. Open the node's page.
2. Select **Shell**.

The shell opens in the browser as PVE's node terminal, with your PVE login. It needs `Sys.Console` on the node. PVE gives a root shell without a password only to `root@pam`; other users see a login prompt. Commands typed here run outside galley's changes and audit log; PVE logs the session. See [Consoles](consoles.md).

For storage, see [Storage](storage.md).
