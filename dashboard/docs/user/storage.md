---
title: Storage
summary: Check storage across clusters, tell disabled from unavailable storage, and browse what a storage holds.
order: 75
route: /storage
---

## The Storage page

**Storage** lists every storage of every cluster: type (and **shared**), the nodes that use it, used space, and status **Available**, **Unavailable** or **Disabled**. Shared storage appears once per cluster; local storage appears once per node. Select a storage to open its page.

PVE reports `unknown` both for storage that is disabled and for enabled storage it cannot reach. galley tells them apart: **Disabled** is turned off in the storage configuration, **Unavailable** is turned on but not working. Unavailable storage also raises a critical finding in **Needs attention**.

## A storage's page

- **Facts**: used and free space, type, and **Seen by**: the nodes that use it, with any that report it unavailable.
- **Used space**: a chart of used space over the chosen time range (7 days by default).
- **Content**: everything on the storage, grouped by kind: **VM disks**, **Container volumes**, **ISO images**, **Container templates**, **Backups**, **Snippets** and **Import**. Each volume shows its name, the guest it belongs to (select it to open the guest), size, format and creation time. For shared storage the list comes from one node.

Listing content needs `Datastore.Audit` or `Datastore.AllocateSpace` on the storage. If the storage is unavailable, PVE cannot list it, and the page says **Content not available**; check the storage backend (for NFS or CIFS, whether the server is reachable from the node).

The storage page is read-only. To upload ISO images or templates, or to delete volumes, use the PVE interface, or the [API explorer](api-explorer.md) for deletions.

## Storage findings

galley raises findings in **Needs attention** on the [Overview](overview.md) when a storage fills up (warning, then critical) or an enabled storage is not available. The **Storage capacity** widget lists the fullest storages, unavailable ones first.
