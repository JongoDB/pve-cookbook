---
title: Getting started
summary: What galley is, how to log in, how the screen is laid out, and how your PVE permissions decide what you see and do.
order: 10
---

galley is a self-hosted web cockpit for one or more Proxmox VE (PVE) clusters. It runs as a single program, usually in a small container on one of your nodes, and talks to each cluster's PVE API.

galley does not replace the PVE web interface. It gives you fleet-wide views, guided workflows (creating guests, mapping GPUs), a built-in assistant, and one safe way to make changes: every change is shown as the exact API calls and `pvesh`/`qm`/`pct` commands before anything runs, and every change is written to an audit log.

## How permissions work

galley has no user database and no permission system of its own. You log in with your PVE account, and galley acts as you:

- You see only what your PVE account can see. Lists, detail pages, metrics and findings are filtered by your PVE permissions on each cluster.
- Every change runs with your own PVE login, so PVE's permission checks apply and PVE's task log shows your user name.
- If PVE refuses something, galley shows PVE's answer. Ask a PVE administrator for the privilege it names.
- Cluster-wide state (Ceph, HA, other users' tasks, the whole audit log) needs `Sys.Audit` on `/` of that cluster.

A few galley functions need more than ordinary PVE rights. See [Clusters and access](clusters-and-access.md) for galley admins, and [Host commands](hosts.md) for host administrators.

## Log in

1. Open galley's address in your browser, for example `https://192.0.2.50:8443`.
2. If galley serves several clusters, choose one under **Cluster**. You log in to this cluster first; you can add the others later.
3. Enter your **User name**, choose the **Realm** (for example `pam` or `pve`, or your LDAP or AD realm) and enter your **Password**.
4. If your account has two-factor authentication, enter the code in **One-time code, if your account has 2FA**. A recovery code works in the same field as `recovery:<code>`.
5. Select **Log in to <cluster>**.

If the login fails, see [Troubleshooting](troubleshooting.md#login-problems).

### Log in with single sign-on

If the cluster has an OpenID Connect realm, the login page shows a button such as **Sign in with <realm>** above the password fields.

1. Choose the cluster.
2. Select **Sign in with <realm>**. galley sends you to your identity provider.
3. Log in there. You come back to galley, logged in.

If single sign-on fails, the login page shows **Single sign-on failed:** and the reason. A galley administrator sets single sign-on up; see [Install and upgrade](install-and-upgrade.md#set-up-single-sign-on).

### One session, one identity

A galley session belongs to one PVE identity, such as `alice@pve`. When you log in to more clusters in the same session, galley asks only for the password (and one-time code) of that same user. To work as a different user, log out and log in again.

## The screen

### Top bar

- **galley** (the logo) takes you to the Overview.
- The breadcrumb trail shows where you are, for example **Guests / lab / web03**.
- **Ask, search or run a command** opens the command palette. The shortcut is ⌘K on a Mac and Ctrl K elsewhere. See [Keyboard and search](keyboard-and-search.md).
- The live indicator shows **Live** while updates stream in, **Polling every 5 s** when the live stream is down and galley falls back to polling, and **Connecting** in between.
- Your user name opens the account menu. It shows whether you are a galley admin, galley's version, and **Log out**.

### Navigation

The left side lists the pages:

- **Overview**: your dashboard of widgets. See [Overview](overview.md).
- **Guests**: every VM and container, with a count. See [Guests](guests.md).
- **Nodes** and **Storage**. See [Nodes](nodes.md) and [Storage](storage.md).
- **Hardware**: PCI devices, GPUs and PCI mappings. See [Hardware and GPUs](hardware-and-gpus.md).
- **Protection**: backup coverage. A count shows how many guests have no backup. See [Protection](protection.md).
- **Activity** and **Audit log**. See [Activity](activity.md) and [Audit log](audit-log.md).
- **Create**: wizards for new VMs and containers. See [Create a VM or container](create.md).
- **Hosts**: shell commands on nodes. Shown only if you hold `Sys.Modify` on `/` of at least one cluster. See [Host commands](hosts.md).
- **API**: the API explorer. See [API explorer](api-explorer.md).
- **Clusters**: one line per cluster with its state: **N of M** nodes online, **stale** when galley has no current data, **loading**, or **log in** when this session is not logged in to it. Select a cluster to open its section on the Clusters page.
- **Add cluster** and **Settings** appear only for galley admins.
- **Help** opens this user guide.

Most pages have a **Help** link next to their title that opens the guide page about them. The command palette also finds help pages.

On a narrow screen the navigation is hidden behind the **Menu** button in the top bar.

### The drawer

The right side holds the drawer with three tabs:

- **Assistant**: chat with galley's assistant. See [Assistant](assistant.md).
- **Changes**: the change waiting for your review. A badge shows **1** when a change is waiting. See [How changes work](changes.md).
- **Activity**: PVE tasks and galley changes that are running, and recently finished tasks.

The drawer starts folded to a narrow rail of icons. Select an icon to open that tab. **Fold the drawer** folds it again. Opening a change always unfolds the drawer to **Changes**, because you must see a change before it runs. On narrow screens, Escape folds the drawer. Left and right arrow keys move between tabs.

### Notices above every page

- **Your login to <cluster> lapsed while you were away.** Select **Log in to <cluster>** and enter your password, or **Later**. Everything else keeps working. See [Clusters and access](clusters-and-access.md#lapsed-logins).
- **Your galley session ends at <time>** appears in the last 10 minutes before your session's maximum lifetime. Changes already running keep going. Log in again afterwards.

## What to do next

- If galley is not installed yet, start with [Install and upgrade](install-and-upgrade.md).
- To find your way around, read [Overview](overview.md) and [Guests](guests.md).
- Before you change anything, read [How changes work](changes.md).
- To let AI agents or scripts work with galley, read [Agents and MCP](agents-and-mcp.md).
