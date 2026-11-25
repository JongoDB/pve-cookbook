---
title: Clusters and access
summary: Add and remove clusters, re-pin certificates, share logins, choose how galley keeps logins, and understand galley admins, cluster logins and session expiry.
order: 140
route: /clusters
---

The **Clusters** page has one section per registered cluster. The navigation lists the clusters too; select one to jump to its section.

## What each cluster shows

- Its state: **Healthy**, **N nodes offline**, **Not quorate** or **Unreachable**, and your login: **Logged in**, **Logged in, admin**, **Login lapsed** or **Not logged in**.
- Nodes online, the endpoint galley is using, and when it last read the cluster. If galley cannot reach it, the reason.
- **Endpoint** and **Pinned SHA-256 fingerprint** for each node address, with **Active** on the one in use. **System-trusted certificate** means the endpoint has a certificate from a public authority and no pin.
- The read-only service token's ID.
- A login form, if you are not logged in to it.

Endpoints and the token ID are shown only if you hold `Sys.Audit` on `/` of that cluster.

galley reads from the first endpoint that answers and fails over to the next. A change is sent to another endpoint only if it never reached a node, so a change is never sent twice.

## Log in to another cluster

A galley session starts with a login to one cluster. To work on another:

1. Open the cluster on the **Clusters** page, or any page for it.
2. Enter your **Password** (and **One-time code** if your account has 2FA) for the same user.
3. Select **Log in to <cluster>**.

The user is fixed for the session: you log in as the same `user@realm` on every cluster. If the other cluster answers for a different user, the login is refused.

Pages for a cluster you are not logged in to stay empty, with a login form where you need it.

### Shared logins

A galley admin can tick **Share logins with other clusters that have this on** for clusters that use the same realm, such as one LDAP or AD directory. When you log in with a password to one of them, galley also logs you in to the others with the same user name and password. Accounts that need a one-time code are not logged in to the others this way; log in to each.

Turn sharing on only for clusters whose realms really are the same directory: the password you type for one is sent to the others.

## Lapsed logins

Your PVE login to a cluster is renewed in the background only while your galley session is in use: while a tab is open, for 30 minutes after your last action, and while one of your changes runs. If you leave galley alone longer, the PVE login lapses after about 2 hours. Your galley session stays valid.

When you come back, galley shows **Your login to <cluster> lapsed while you were away.**:

1. Select **Log in to <cluster>**.
2. Enter your password (and one-time code).

Nothing else is lost. The same happens when PVE stops accepting your login, for example when a token galley created for you is revoked in PVE.

## Sessions and expiry

- A galley session ends after 4 hours without any request, and 12 hours after you logged in, however active you are. An administrator can change both (see [Install and upgrade](install-and-upgrade.md#options)).
- In the last 10 minutes, galley warns you: **Your galley session ends at <time>**. Changes already running keep going.
- When the session ends, galley shows the login page with **Your session ended. Log in again.**
- **Log out** in the account menu ends the session at once and removes your stored PVE logins.

Sessions survive a galley restart.

## Galley admins

Some settings affect everyone, so they need a **galley admin**. You are a galley admin if either:

- you hold `Sys.Modify` on `/` in every registered cluster, and you are logged in to all of them in this session; or
- galley was started with `--admin <cluster>:<user@realm>` for you, and you are logged in to that cluster as that user.

The account menu shows **galley admin** when you are one.

Galley admins can:

- add clusters (**Add cluster**);
- change a cluster's endpoints;
- turn on shared logins;
- choose the credential mode and the host transport;
- change [Settings](settings.md), such as the assistant.

Renaming and removing a cluster needs `Sys.Modify` on `/` of that cluster.

## Add a cluster

You must be a galley admin.

1. Select **Add cluster** in the navigation or on the Clusters page.
2. Under **API endpoints**, enter every node of the cluster, one per line (port 8006 unless you add one).
3. Select **Probe endpoints**. Compare each **SHA-256 fingerprint** with `pvenode cert info` on that node, and tick **Trust**.
4. Enter the **Cluster name**, the **Service token ID (read-only, PVEAuditor)** and the **Token secret**. Create the token first if needed (see [Install and upgrade](install-and-upgrade.md#the-service-token)).
5. Optionally tick **Share logins with other clusters that share this setting**.
6. Select **Add cluster with N endpoints**.
7. Log in to the new cluster.

galley refuses a token that can change anything, or that lacks `Sys.Audit` on `/`.

## Rename a cluster

1. In the cluster's section, select **Rename**.
2. Enter the new name and select **Rename cluster**.

This changes the name in galley only. You need `Sys.Modify` on `/` of that cluster.

## Update endpoints and re-pin certificates

Do this after adding a node, removing one, or renewing a node's certificate (a renewed self-signed certificate has a new fingerprint, and galley refuses it until you pin it again).

1. In the cluster's section, select **Update endpoints**. You must be a galley admin.
2. Edit the list of addresses and select **Probe endpoints**.
3. Compare each fingerprint with `pvenode cert info` on that node and tick **Trust**.
4. Select **Save N endpoints**. galley checks that the cluster answers at the new endpoints before saving.

## Remove a cluster from galley

1. In the cluster's section, select **Remove from galley**.
2. Type the cluster's name and select **Remove <cluster>**.

galley forgets the cluster: its endpoints, service token and pinned host keys. The cluster itself is not touched. Personal API tokens galley created on it are not revoked; they expire on their own. You need `Sys.Modify` on `/` of that cluster, or to be a galley admin.

## How galley keeps your login

A galley admin chooses, per cluster, under **How galley keeps user logins to <cluster>**:

- **PVE login tickets** (default): galley keeps your PVE ticket and renews it while your session is in use. Everything PVE allows you works.
- **Personal API tokens**: at login, galley uses your ticket once to create a PVE API token for you, named `galley-<random>`, with your own permissions and an expiry at the end of your session's maximum lifetime, then discards the ticket. You can see and revoke the token in PVE, and PVE's task log shows `user@realm!galley-…`. galley deletes it when you log out. Operations PVE reserves for a `root@pam` ticket do not work in this mode: raw PCI passthrough without a mapping, some root-only settings, and host commands through the PVE node terminal. Consoles need a PVE version that accepts API tokens for consoles.

A change applies to new logins; existing logins keep working until they lapse. If PVE refuses to create the token, the login fails with **Your password was accepted, but <cluster> refused to create the session token**.

Either way, your PVE login is stored encrypted with a key that exists only in your browser's cookie and, while you use galley, in galley's memory. See [Security](security.md).

## Choose how host commands reach the nodes

A galley admin chooses, per cluster, under **How host commands reach the nodes of <cluster>**:

- **PVE node terminal** (default): host commands run in PVE's node terminal as the user; they need a `root@pam` login; galley stores no SSH key.
- **galley SSH key**: galley keeps an SSH key that is root on the nodes, so non-root administrators can run host commands.

Switching from SSH to the PVE node terminal asks you to confirm with **Delete the key and switch**: galley deletes its SSH key and every pinned host key for the cluster. See [Host commands](hosts.md).
