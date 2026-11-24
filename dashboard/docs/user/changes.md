---
title: How changes work
summary: How every change in galley is reviewed, confirmed, applied as you, followed to completion and recorded.
order: 40
---

Nothing in galley touches a cluster until you apply it in the **Changes** tab of the drawer. This is true for every change, whoever or whatever started it: a button on a guest, a fix on a finding, a wizard, the command palette, the API explorer, a host command, the assistant, or an agent token that can only draft. The one exception is an agent token you created with the **apply** scope: it applies changes as you, without the Changes tab (see [Agents and MCP](agents-and-mcp.md)).

## The life of a change

1. **You start a change.** For example, select **Shut down** on a guest, or **Review change** in a wizard. galley builds the change on the server and opens the drawer on **Changes**.
2. **You review it.** The Changes tab shows:
   - the title, the cluster, and **runs as you (<your user>)**;
   - a summary, if there is one;
   - a warning, if the change is destructive;
   - the numbered steps, one per API call;
   - the exact commands, as `pvesh`, `qm` or `pct` lines. **Copy** copies them, so you can run the same change from a shell or keep it for a runbook.
3. **You confirm it, if asked.** Destructive changes ask you to type a confirmation text (see below).
4. **You apply it.** Select **Apply change**. The button shows **Applying** while it runs.
5. **galley runs it as you.** galley records the change in the audit log as running before it sends anything, then sends each step with your PVE login.
6. **You see the outcome.** Each step shows its status. When the change ends, galley says **Change applied. It is in the audit log.** or **The change stopped at a failed step. Nothing after it ran.** Select **Open audit log** or **Close**.

To drop a change without running it, select **Discard**.

## One change at a time

The Changes tab holds one change. If you start another change before you apply or discard the first, the new one replaces it. The badge on the **Changes** tab counts the changes waiting for you: the one open in the tab, plus drafts by the assistant or agents that you have not applied or discarded yet.

A change you have not applied expires after 10 minutes; **Apply change** is then unavailable. Start it again to get a fresh one. A change runs at most once.

## Step statuses

- **Running**: the step was sent, and PVE is working on it. If PVE started a task, its ID (UPID) is shown.
- **Done**: the step finished. A step counts as done only when its PVE task ends with `OK` or with warnings; warnings are shown after **Done:**.
- **Failed**: the step failed, with PVE's reason. The change stops there. Steps after it do not run.
- **Unknown: galley stopped following this task. Check the PVE task log.** galley stops following a task after 6 hours, or when galley restarts. The task may still be running, or may have finished, in PVE.
- **Waiting for the previous step**: steps run in order, one after the other.

## Changes keep running without you

A change runs on the galley server, not in your browser. You can close the tab, change pages or fold the drawer; the change continues, and galley keeps your PVE login alive until it finishes. Running changes appear in the **Activity** tab of the drawer and on the [Activity page](activity.md).

If galley restarts while a change runs, the change is marked as failed with a note to check the PVE task log.

## Typed confirmation

Some changes ask you to type a text before **Apply change** works. The field reads **Type `<text>` to confirm**. Type it exactly.

- **Destroy** a guest: `destroy <vmid>`, or `destroy <vmid>,<vmid>` for several. Destroy permanently deletes the guest and all its disks (`--purge 1 --destroy-unreferenced-disks 1`) and removes it from backup jobs and HA. A running guest is stopped first. Backups are not touched.
- **Host commands**: always `run on <node>`. See [Host commands](hosts.md).
- **Generic API changes** (from the resource editor, the API explorer, the wizards or the assistant) that are destructive:
  - one `DELETE` call: `delete <last two parts of the path>`, for example `delete qemu/300`;
  - one other destructive call: `confirm <last two parts of the path>`, for example `confirm 300/config`;
  - several calls: `apply <N> changes`.
- **Removing a cluster from galley** (as a drafted change): `remove <cluster id>`.
- **Assistant and agent drafts**: always need a typed confirmation. If the change has none of its own, it is `apply <N> steps` (or `apply 1 step`).

An API change counts as destructive when it deletes something; stops, resets or suspends a guest; rolls back a snapshot; wipes or initializes disks, or creates disk storage on them; moves disks; changes a password; or when its body deletes settings (`delete`), purges, forces, skips locks, reboots or shuts down a node, removes ACLs, turns a firewall on or off, or stops or disables an HA resource. Editing a guest's configuration and removing a setting therefore asks for confirmation.

**Stop** (a hard power-off) is marked destructive and warns that guests lose power without a clean shutdown, but it needs no typed text.

## Changes the assistant drafts

The assistant can only draft changes. A draft appears in the conversation as a card labelled **Assistant draft**, with its commands. Select **Review in Changes** to open it. In the Changes tab it is titled **Assistant draft: …** and carries a warning to check every command, because the assistant drafted it from what it read in the cluster. You confirm it by typing its confirmation text, then apply it like any other change. See [Assistant](assistant.md).

## Changes to galley's own settings

Some changes affect only galley, not the cluster. They go through **Changes** too when the [assistant](assistant.md) or an [agent](agents-and-mcp.md) drafts them, or when a script uses galley's API:

- `galley.cluster.update`: rename a cluster in galley, turn login sharing on or off, or change the credential mode (`ticket` or `token`) or the host transport (`pve` or `ssh`);
- `galley.cluster.remove`: remove a cluster from galley. The cluster itself is not touched. Typed confirmation: `remove <cluster id>`;
- `galley.host.pin` and `galley.host.unpin`: trust or forget a node's SSH host key (SSH transport only);
- `galley.prefs.set`: change one of your own preferences, such as your Overview layout.

Such a change is marked **galley setting** and says it is **applied by galley for you**. Instead of commands it lists what it changes in galley; there is no command to copy. When you apply it, galley makes the change with your rights, exactly as if you had made it on the Clusters or Hosts page, so the same permission rules apply (see [Clusters and access](clusters-and-access.md)). It is recorded in the audit log like any other change.

On the Clusters and Hosts pages themselves, these settings are applied directly when you select the button, without a stop in Changes.

## Pending changes

Every change you have not yet applied or discarded, including drafts by the assistant and by your agent tokens, stays pending for 10 minutes. Scripts and agents list them with `GET /api/plans`. You can have at most 50 pending changes. The **Changes** tab shows the one you opened last.

## Changes drafted by agents

An agent token with the **draft** scope drafts changes the same way as the assistant. Its drafts are titled **Agent draft (<token name>): …** and always need typed confirmation. An agent token with the **apply** scope can apply changes itself, passing the confirmation text; those changes are recorded in the audit log like yours. See [Agents and MCP](agents-and-mcp.md).

## How galley validates a change

- Guest actions only target guests your PVE account can see.
- Generic API calls are checked against the cluster's own API schema before you see them: the method must exist for that path, every parameter must exist, and values must have the right type, range and allowed values. Required parameters must be present. Paths must be plain (no trailing slash, no percent-encoding). A change holds at most 20 calls.
- Passwords, tokens and keys in a change are hidden in the commands and the audit log.
- PVE itself checks your permissions when each step runs.

## If galley cannot prepare a change

The Changes tab shows **Could not prepare the change:** and the reason, for example an invalid parameter or a node that is not online. Select **Try again** after fixing the cause, or **Discard**.

If you are not logged in to that cluster, the tab asks for your password (**Log in to <cluster>**) and then prepares the change.

## Where changes are recorded

Every applied change is in the **Audit log** with its commands, who ran it, each step's result and the PVE task IDs. See [Activity](activity.md) and [Audit log](audit-log.md).
