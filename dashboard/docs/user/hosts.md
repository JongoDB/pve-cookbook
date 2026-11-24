---
title: Host commands
summary: Run reviewed, audited shell commands as root on cluster nodes for what the PVE API cannot do, and set up the PVE terminal or SSH transport.
order: 130
route: /hosts
---

Some tasks have no PVE API: NIC flow control, kernel parameters, disk tools, packages. The **Hosts** page lets you run a shell command as root on a node, through the same review as every other change, with its output kept in the audit log.

Prefer the PVE API whenever it can do the job (see [API explorer](api-explorer.md)). Host commands run as root outside PVE's permission checks.

## Who can run host commands

You need administrator rights on `/` of that cluster: `Sys.Modify`, `Sys.Console` and `Permissions.Modify`. The **Hosts** entry appears in the navigation when you hold `Sys.Modify` on `/` of at least one cluster. If you lack the other rights, the page says **No host access on <cluster>** and names them.

What else you need depends on the cluster's transport (see below):

- **PVE node terminal** (the default): you must be logged in to that cluster as `root@pam`.
- **galley SSH key**: any user with the administrator rights above.

## Run a command

1. Open **Hosts**. Each cluster lists its nodes.
2. On the node, select **Run a command**.
3. Enter the **Command**. It runs as `bash -c` as root, with no input, and is limited to 30 minutes. For example: `ethtool -A enp65s0f0 rx off tx off`.
4. Enter a **Reason**. It is kept in the audit log.
5. Select **Review command**. The change opens in **Changes**, marked as running as root on the node, outside PVE's permission checks.
6. Type `run on <node>` and select **Apply change**.

The step shows the command's output (up to 256 KiB) with **Copy output**, and fails if the command exits with a non-zero status. The output and exit status are stored in the audit log, visible to you and to holders of `Sys.Audit` on that cluster. Do not print secrets.

The node must be online. A command can be up to 8000 characters.

## Transports

A galley admin chooses, per cluster on the [Clusters](clusters-and-access.md#choose-how-host-commands-reach-the-nodes) page, how host commands reach the nodes. The Hosts page shows which one a cluster uses.

### PVE node terminal (default)

galley opens PVE's own node terminal as you, the same as **Shell** in the PVE interface, types the command and collects its output. galley stores no root credential, and PVE logs the terminal session under your user.

PVE gives a root shell without a password only to `root@pam`. For anyone else it shows a login prompt; galley types nothing into it and the step fails with an explanation. So with this transport, log in to galley as `root@pam` to run host commands. If you are logged in as someone else, the Hosts page says so.

This transport does not work with personal API tokens (credential mode **Personal API tokens**), because PVE's node terminal is not a root shell for a token.

Output is collected from a terminal: carriage returns are removed, and some tools format their output differently than over SSH.

### galley SSH key

galley keeps one SSH key per cluster and connects as root over SSH. Any user with the administrator rights above can then run host commands, without logging in as `root@pam`. The cost: galley stores a credential that is root on every node, at any time. See [Security](security.md).

To set it up after a galley admin has switched the cluster to **galley SSH key**:

1. Open **Hosts**. The cluster shows **galley's SSH key for <cluster>** and an install command.
2. Select **Copy install command** and run it once, as root, on any node of the cluster. It appends galley's key to `/etc/pve/priv/authorized_keys`, which every node shares, so all nodes trust it at once. The key's `restrict` option turns off forwarding, agents and X11.
3. Pin each node's SSH host key (next section). Until a node is pinned, it shows **Not pinned** and has no **Run a command** button.

## Pin a node's SSH host key

Pinning makes sure galley talks to the real node and not to something else at its address.

1. On the node, select **Read host key**. galley shows the fingerprint the node at its cluster address presents.
2. Log in to the node through a path you already trust (the PVE shell, IPMI or a console) and run:

   ```bash
   ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
   ```

3. Paste the `SHA256:…` part into **Fingerprint you saw on <node>**. galley shows **Matches.**, or warns that it does not match: then do not pin.
4. Select **Pin <node>**. galley reads the key again from the node's cluster address and pins it only if it still matches.

The node then shows **Host key pinned**, with the fingerprint, address, who pinned it and when. galley refuses to connect to a node whose key differs from the pin.

To unpin, select **Unpin**, then **Unpin <node>**. That stops host commands on the node until you pin it again. Re-pin after you reinstall a node or replace its SSH host keys.

## Switch back to the PVE node terminal

When a galley admin switches a cluster from SSH back to **PVE node terminal**, galley deletes its SSH key for that cluster and every pinned host key. Then remove galley's line (it starts with `restrict ssh-ed25519` and ends with `galley`) from `/etc/pve/priv/authorized_keys` on any node.

## The assistant and host commands

If you are a host administrator, the [assistant](assistant.md) can draft host commands for you to review. Otherwise it gives you the command to pass on to an administrator.
