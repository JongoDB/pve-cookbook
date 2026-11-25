---
title: Activity
summary: Follow running PVE tasks and galley changes across clusters, in the drawer and on the Activity page.
order: 44
route: /activity
---

galley shows two kinds of history:

- **Activity** shows PVE tasks (the same tasks as the PVE task log) and galley changes that are running.
- **Audit log** shows what was done through galley: changes, logins and cluster administration, with the exact commands.

## See what is running

The **Activity** tab of the drawer shows, at a glance:

- **Running**: galley changes (labelled **Change**, with the step it is on) and PVE tasks (labelled **Task**, with the node, user and start time).
- **Finished**: the latest finished tasks, marked **OK**, **Warnings** or **Failed**.

Select **All activity** for the full page.

## The Activity page

The **Activity** page (route `/activity`) lists the newest 50 PVE tasks across all clusters, live: start time, cluster, node, task type, guest or ID, user, and result. When galley changes are running, they are listed first under **Changes running**. With several clusters, filter with **Cluster**.

Like PVE, you see your own tasks, and everyone's tasks on clusters where you hold `Sys.Audit` on `/`.

For a single guest's tasks, open the guest's **Task history** tab. See [Guests](guests.md).

For what was changed through galley, by whom, with the exact commands, see [Audit log](audit-log.md).
