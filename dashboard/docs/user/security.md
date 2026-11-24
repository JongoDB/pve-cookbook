---
title: Security
summary: What galley stores and never stores, who can do what, and how to run galley safely.
order: 160
---

galley acts on your clusters as the logged-in user. This page summarizes how it protects that power. The full threat model is in galley's `docs/security.md`.

## galley has no authority of its own

- galley reads each cluster's state with a **read-only service token** (`PVEAuditor`). galley refuses tokens that can change anything. The token is never used for anything a user sees unfiltered, and never for a change.
- Everything you see is filtered by **your own PVE permissions**.
- Every change runs with **your own PVE login**, so PVE's permission checks apply and PVE's task log shows your name.
- There is no galley user database and no second permission system.

## What galley stores

In its data directory (`/var/lib/galley`):

- **Your PVE login per cluster**: a ticket, or a personal API token in token mode. It is encrypted with a key derived from a secret that exists only in your browser's session cookie and, while you use galley, in galley's memory. A copy of galley's database and key file does not reveal it.
- **Service tokens** (read-only), the **assistant API key**, and, only if a galley admin turned on the SSH transport, an **SSH key** per cluster. These are encrypted with galley's instance key, `secret.key`.
- **Pinned certificate fingerprints** of each cluster's nodes, and pinned SSH host keys.
- **Sessions** (by a one-way hash of their ID), the **audit log** and **preferences** such as your Overview layout.

## What galley never stores

- Your PVE password. It is used once, to log in, and forgotten.
- Assistant conversations. They live in memory only and are dropped after 2 hours idle or on restart.
- Metrics history. Charts read PVE's own history.

## How long your login lives

- galley keeps the key to your stored login in memory only while you use galley: for 30 minutes after your last request, while a tab is open, and while one of your changes runs.
- Without it, your PVE ticket is not renewed and lapses after about 2 hours. You then enter your password again for that cluster.
- Your galley session ends after 4 hours idle or 12 hours after login (adjustable by the administrator).
- **Log out** deletes the session and its stored logins, and revokes personal API tokens.

## Who can do what

- **Any user** sees and does only what PVE allows their account.
- **Cluster administrators** (`Sys.Modify` on `/` of a cluster) can rename and remove that cluster in galley.
- **Host administrators** (`Sys.Modify`, `Sys.Console` and `Permissions.Modify` on `/`) can run host commands. With the default transport they must also be logged in as `root@pam`. See [Host commands](hosts.md).
- **Galley admins** (`Sys.Modify` on `/` in every cluster, or named with `--admin`) can add clusters, change endpoints, enable shared logins, choose credential mode and host transport, and change settings. See [Clusters and access](clusters-and-access.md#galley-admins).
- **The assistant** reads with your permissions and can only draft changes. Its drafts always need typed confirmation.
- **Agent tokens** act as the user who created them, limited by their scope (read, draft or apply), and can never administer galley. See [Agents and MCP](agents-and-mcp.md).

## Protections

- **Certificate pinning**: galley talks to each node only if its certificate is trusted by the system or matches the fingerprint you confirmed.
- **Review before every change**, with typed confirmation for destructive ones, and an audit entry written before anything is sent.
- **Login rate limits**: after 10 failed logins in 15 minutes for a user name or a client address (or more than 30 attempts in a minute), further attempts are refused for a while.
- **Cookies** are `Secure`, `HttpOnly` and `SameSite=Lax`. Changes need a per-session CSRF token and a same-origin request.
- **Single sign-on** flows are bound to the browser that started them.
- **Secrets in changes** (passwords, tokens, keys) are hidden in commands and the audit log.

## What is left over

- Someone with root on the galley container while you use it can act as you. Keep the container minimal and patched, and limit who can reach it (VPN, firewall).
- A stolen browser cookie is as good as your session until it ends or you log out.
- `galley.db` together with `secret.key` reveals the read-only service tokens, the assistant API key and, if enabled, the SSH key. Protect backups of `/var/lib/galley`.
- Host-command output is stored in plain text in the audit log.
- The assistant sends what it reads to the configured model provider.

## Good practice

- Use non-root accounts with scoped roles for daily work. Log in as `root@pam` only when you need it.
- Prefer **Personal API tokens** for clusters where you do not need root-only operations: stolen tokens expire and can be revoked in PVE.
- Keep the session lifetime short.
- Give galley a real TLS certificate (`--tls-cert`, `--tls-key`), or check its self-signed fingerprint in your browser.
- Keep the SSH transport off unless non-root administrators must run host commands.
- Give agent tokens the smallest scope and shortest life that works.
