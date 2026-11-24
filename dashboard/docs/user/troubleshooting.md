---
title: Troubleshooting
summary: What galley's error messages mean and what to do about them, from failed logins to stale clusters, assistant errors and refused consoles.
order: 180
---

## Login problems

- **Wrong user name, realm or password. Check them and try again.** PVE refused the login. Check the **Realm**: `root` is in `pam`; users created in PVE are usually in `pve`; directory users are in their LDAP or AD realm.
- **This account needs a one-time code. Enter it and log in again.** Enter your TOTP code in **One-time code, if your account has 2FA**, or a recovery code as `recovery:<code>`.
- **Too many attempts. Try again in N seconds.** galley limits failed logins per user name and per client address (10 failures in 15 minutes, or 30 attempts in a minute). Wait for the countdown; the button unlocks by itself. Logins that fail because the cluster is unreachable do not count.
- **Your password was accepted, but the cluster refused to create galley's session token.** The cluster uses personal API tokens (see [Clusters and access](clusters-and-access.md#how-galley-keeps-your-login)) and PVE did not let galley create one for you. Ask a galley admin to check the cluster's login mode, or your PVE rights.
- **Single sign-on failed: …** The identity provider or PVE's OpenID realm refused. Check that the realm's client allows `https://<galley-host>/api/login/openid/callback` as a redirect URI and that galley runs with `--public-url`. See [Install and upgrade](install-and-upgrade.md#set-up-single-sign-on).
- **Could not read this cluster's realms (…); showing the defaults.** galley could not list the realms; only `pam` and `pve` are offered. Your realm may still work once the cluster is reachable.
- **galley's API did not answer** (before the login page): the galley service is not running or not reachable. Check `systemctl status galley` and `journalctl -u galley` in the galley container, then select **Retry**.
- **Your session ended. Log in again.** Your galley session reached its idle or maximum lifetime, or you logged out elsewhere. Log in again.

## "Log in to <cluster>"

You are logged in to galley, but not to this cluster in this session. Enter the password for your user and select **Log in to <cluster>**. Pages, charts and widgets for that cluster stay empty until you do. In the navigation, the cluster shows **log in**.

**Could not log in to <cluster>: … Check the password for <user>.** galley logs you in as the same user on every cluster. If you use a different account on that cluster, log out and log in as that account.

## A login lapsed

**Your login to <cluster> lapsed while you were away.** Your PVE login was not renewed while you were away (galley renews it only while you use galley) and has expired, or PVE stopped accepting it. Select **Log in to <cluster>** and enter your password. See [Clusters and access](clusters-and-access.md#lapsed-logins).

## A cluster is stale or unreachable

- **stale** in the navigation, **Unknown** in widgets, or **<cluster> has not answered recently; last good data …**: galley could not read the cluster's status on the latest attempts. It keeps showing the last good data, marked as such.
- **Unreachable** on the Clusters page, with the reason.

Check:

1. That the nodes are up and port 8006 is reachable from the galley container (for example `curl -k https://<node>:8006` from inside it).
2. That the endpoints on the Clusters page are still the nodes' addresses.
3. Whether a node's certificate was renewed. A new self-signed certificate does not match the pinned fingerprint, so galley refuses it. A galley admin selects **Update endpoints**, probes, compares the fingerprint with `pvenode cert info`, and saves. See [Clusters and access](clusters-and-access.md#update-endpoints-and-re-pin-certificates).
4. Whether the service token still exists and is not expired (`pveum user token list galley@pve`).
5. **The stored token secret cannot be decrypted (was secret.key replaced?)**: galley's `secret.key` no longer matches its database. Restore the matching `secret.key`, or remove the cluster and add it again.

**Unknown** for only one part (Ceph, HA, backup coverage, storage configuration and so on) means that part's read failed; **Needs attention** shows the error as "could not read …". Often the service token lacks `Sys.Audit` on `/`.

## Something is missing or a page is empty

- You see only what your PVE account can see. A guest you cannot see in PVE is not in galley either.
- Cluster-wide state (Ceph, HA, all tasks, other users' audit entries, whole-cluster charts) needs `Sys.Audit` on `/`.
- **Disk list not available** or **PCI devices not available**: these lists need `Sys.Audit` on the node or on `/`.
- **Your PVE account does not have permission for this.** PVE refused the read. Ask an administrator for the privilege PVE named.
- The **Hosts** and **Settings** entries appear only for users with the rights they need.

## A change failed

- **Could not prepare the change: …** galley checked the change and found a problem before anything ran, for example a parameter the API does not accept, or a node that is offline. Fix it and select **Try again**.
- **Apply change** stays unavailable: type the confirmation text exactly, or the change has expired (after 10 minutes). Start it again.
- **Failed: …** on a step: PVE refused or the task failed. The reason is PVE's. Steps after it did not run. Check **Details** in the [Audit log](audit-log.md) and the PVE task log.
- **Unknown: galley stopped following this task.** Check the task in PVE's task log; it may have finished.
- A configuration change was rejected because the configuration changed meanwhile: open the editor again so it starts from the current values.

## Host command problems

- **PVE opened a login prompt instead of a shell**: with the PVE node terminal transport, host commands need a `root@pam` login. Log in as `root@pam`, or ask a galley admin to switch the cluster to the SSH transport. See [Host commands](hosts.md).
- **host commands need administrator rights on /**: you need `Sys.Modify`, `Sys.Console` and `Permissions.Modify` on `/`.
- **This does not match what <address> presents. Do not pin**, or **Not pinned: the node presents …**: the SSH host key you checked on the node is not the one at its address. Make sure you ran `ssh-keygen -lf` on that node itself. If you reinstalled the node, that is expected: compare carefully, then pin the new key.
- With the SSH transport, galley refuses to connect to a node whose host key no longer matches its pin. If the node's keys changed legitimately, unpin it and pin it again.
- **command exited with status N**: the command ran and failed. Its output is in the step and in the audit log.

## Console problems

- **PVE refused the console: it needs VM.Console on the guest** (or **Sys.Console on /nodes/<node>**): ask an administrator for that privilege.
- The **Console** button is unavailable: the guest is not running, or you are not logged in to its cluster.
- **The console connection dropped. The VM may have stopped, or the link expired.** Select **Reconnect**.
- **PVE did not accept the terminal ticket.** Select **Reconnect**; if it repeats, log out and in again.
- A node shell shows a login prompt: PVE gives a passwordless root shell only to `root@pam`.

See [Consoles](consoles.md).

## Assistant errors

- **The assistant is not set up yet.** A galley admin must connect a model provider in **Settings**. See [Assistant](assistant.md#set-up-the-assistant-galley-admins).
- **The assistant is set up but turned off.** The API key is saved but **Turn on the assistant for every galley user** is unticked. A galley admin ticks it in **Settings** and saves.
- **The assistant was turned off.** A galley admin turned it off.
- **The assistant is not configured correctly: …** The settings are incomplete, for example a missing API key. A galley admin can fix them in **Settings**.
- **This conversation is full.** Select **New conversation**.
- **This conversation ended on the server (it expired or galley restarted). Start a new one.** Conversations are dropped after 2 hours idle and when galley restarts.
- **The assistant is still answering in this conversation.** Wait, or select **Stop**.
- **Too many messages.** Wait a minute, then send again.
- **The answer stopped before it finished (the connection closed).** Send the message again.
- **The assistant could not answer: …** The model provider returned an error, for example an invalid API key, an unknown model name, or an unreachable endpoint. A galley admin should check the provider settings.
- A lookup line marked as failed means PVE or galley refused that read. The assistant usually explains which permission is missing.

## Feedback problems

- **Send feedback is missing.** A galley admin turned it off in **Settings**. See [Settings](settings.md#feedback).
- **Continue on GitHub opened nothing.** Your browser may block new tabs from galley; allow pop-ups for galley's address and try again.
- **GitHub shows an empty form or asks you to sign in.** Sign in to GitHub; it then shows the filled-in issue. See [Send feedback](feedback.md).

## Agent token problems

- **403** with code `agent_scope`: the token's scope does not allow that call, or the call is galley administration, which agent tokens can never do.
- **the agent token was rejected (expired or revoked)** (from `galley mcp`): create a new token.
- **galley certificate does not match --fingerprint**: the fingerprint passed to `galley mcp` is not galley's current certificate.

See [Agents and MCP](agents-and-mcp.md).

## Overview layout

**Your changes stay on this page until you reload.** galley could not save your layout. Check your connection; your next change tries again.
