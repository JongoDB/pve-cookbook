---
title: Consoles
summary: Open a VM's display, a container's terminal or a node shell in the browser, and what permissions each needs.
order: 100
route: /console/:cluster/:type/:node
---

galley opens PVE's own consoles in the browser. It asks PVE for a console ticket with your login, so PVE's permission checks apply, and passes the connection through over the cluster's pinned TLS connection.

## Open a console

- **VM or container**: open the guest and select **Console**. The guest must be running; otherwise the button says **Start the guest to open its console**.
- **Node shell**: open the node's page and select **Shell**.

The console fills the page. Keyboard input goes to the guest or node while the console has focus.

## VM display

A VM's console is its screen, shown with noVNC.

- **Send Ctrl+Alt+Del** sends that key combination to the VM (your own Ctrl+Alt+Del would go to your computer).
- **Full screen** shows the display full screen.
- **Reconnect** opens a fresh connection.
- **Back to <guest>** returns to the guest's page.

You need `VM.Console` on the VM.

## Container terminal

A container's console is a text terminal into the container, like `pct console`. The toolbar has **Full screen**, **Reconnect** and **Back to <guest>**. You need `VM.Console` on the container.

## Node shell

A node shell is PVE's node terminal (the same as **Shell** in the PVE interface). You need `Sys.Console` on the node.

- PVE opens a root shell without a password only for `root@pam`. Other users see a login prompt.
- Commands you type in a shell run outside galley's changes and audit log. PVE logs the terminal session under your user. For commands you want reviewed and recorded, use [Host commands](hosts.md).

## When the console closes

- **The shell session ended.** or **The VM console closed.**: the session ended normally. Select **Reconnect** to open a new one.
- **The console connection dropped. The VM may have stopped, or the link expired.**: select **Reconnect**.
- **PVE refused the console: it needs VM.Console on the guest** (or **Sys.Console on /nodes/<node>**): your account lacks the permission. Ask a PVE administrator.
- **PVE did not accept the terminal ticket.**: select **Reconnect**. If it keeps happening, log out and in again.

galley asks PVE for a new console ticket every time you open the page or select **Reconnect**. Each connection works once, within one minute of the ticket.

With personal API tokens (see [Clusters and access](clusters-and-access.md#how-galley-keeps-your-login)), consoles need a PVE version that accepts API tokens for consoles.
