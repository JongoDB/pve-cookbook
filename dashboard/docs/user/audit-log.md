---
title: Audit log
summary: Look up who changed what through galley, with the exact commands, step results and host-command output.
order: 46
route: /audit
---

The **Audit log** page shows what was done through galley: changes, logins and cluster administration, with the exact commands. It does not show PVE tasks started outside galley; see [Activity](activity.md) for those.

## Read the audit log

The page lists the newest 100 entries, newest first:

- **Result**: **Running**, **Done** or **Failed**.
- **When** the entry was created.
- **Change**: the title, and the action below it (for example `guest.migrate`, `api.call`, `host.exec`, `auth.login`).
- **Cluster**.
- **Ran as**: the PVE identity the change ran as. If it differs from your galley session's user, the session user is shown below it. When an AI agent or script applied the change with one of your agent tokens, **via agent <name>** appears below it, with the token's name. See [Agents and MCP](agents-and-mcp.md).

Select **Details** to see the commands, and each step's status, PVE task ID or error. Host commands also show their output, with **Copy output**. **Copy** copies the commands so you can repeat the change from a shell.

## What the audit log records

- Every change applied through galley, recorded as running before anything is sent, then updated as each step finishes.
- Logins (`auth.login`), including failed attempts with the client's address.
- Cluster administration: adding, changing and removing clusters (`cluster.add`, `cluster.update`, `cluster.delete`).
- Changes to galley's settings, such as the assistant (`settings.assistant`) and feedback (`settings.feedback`).
- With personal API tokens, the revocation of old session tokens (`auth.token`).

Reads (opening pages, the API explorer's **Read it now**, the assistant's lookups) are not recorded. Commands you type in a console or node shell are not recorded by galley either; PVE logs the console session.

## Who sees which entries

Entries belong to a cluster. You see an entry if you are logged in to that cluster in this session, and either:

- you hold `Sys.Audit` on `/` of that cluster, which shows everyone's entries for it; or
- the entry ran as you.

Host-command output is stored as plain text and is visible to the user who ran it and to holders of `Sys.Audit`. Do not print secrets in host commands.

## The Recent changes widget

The **Recent changes** widget on the [Overview](overview.md) shows the latest six audit entries with who ran them. **Open the audit log** opens the full page.
