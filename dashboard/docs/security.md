# galley security model

galley is a web cockpit that acts on Proxmox VE clusters **as the logged-in user**. To do that it
has to hold something that lets it speak for that user. That makes the galley container worth
attacking. This document lists what galley holds, who might come after it, what each defence
buys, and what is left over.

## Assets

| Asset | Where | Power if stolen |
|---|---|---|
| **User PVE credentials**: a ticket per user and cluster (default), or a per-session API token (`credentialMode: "token"`) | `session_creds`, sealed per session (see below) | Everything that user can do in PVE. For `root@pam` that includes a root shell on every node. |
| **Session secret K** | The browser cookie only. In galley's memory while the session is in use. | Together with the database: that session's PVE credentials. |
| **Instance key** `<data>/secret.key` | The galley data directory | Decrypts the service tokens, settings, assistant key and SSH key. On its own it does **not** decrypt user credentials. |
| **SSH private key** per cluster (only with `hostTransport: "ssh"`, which is opt-in) | `settings` `hosts.key.<cluster>`, sealed with the instance key | Root on every node that authorized it, at any time, needing nobody's login. |
| **Service token** per cluster (PVEAuditor, read-only) | `clusters`, sealed with the instance key | Reads the whole cluster's configuration and state. No changes. |
| **Assistant API key** | `settings`, sealed with the instance key | Model-provider spend. Conversations are not stored. |
| Audit log, preferences | SQLite | Disclosure only (host-command output can be sensitive). |

## Attackers, and what each one gets

| Attacker | Gets today | Notes |
|---|---|---|
| **DB or backup theft** (`galley.db` without `secret.key`) | Nothing secret. Metadata only: user names, audit log, which clusters exist. | Every secret is sealed with AES-GCM. |
| **Data-directory theft** (`galley.db` + `secret.key`, e.g. a CT backup or a stolen disk) | Service tokens (read-only), assistant key, the SSH key if SSH is enabled. **No user credentials.** | User credentials need K, which is never written to disk. |
| **Root on the galley CT, passive** (reads disk and memory once) | All of the above, plus the K of sessions in use: about 30 minutes of activity, open tabs, running changes. With those, the PVE logins of the users active at that moment. | Sessions that are idle or abandoned cannot be decrypted. |
| **Root on the galley CT, persistent** | Can act as every user who uses galley while the attacker is present, by patching the binary or reading cookies from requests. | Unavoidable for a server that acts for users. See [Residual risk](#residual-risk). |
| **Malicious galley user** | Only what PVE lets that user do. Reads are filtered by the user's own PVE permissions. Changes run with the user's own credential. Host commands need administrator rights on `/`. | One session is one identity, so a user cannot add someone else's login to their session. |
| **Compromised PVE node** | Already root on that cluster. It can mint tickets for any name, so galley qualifies `--admin` by cluster. With SSH enabled, a pinned host key stops galley from being pointed at another machine. | A node cannot reach other clusters through galley: SSH keys are per cluster, and shared logins are opt-in per cluster. |
| **Network attacker** | Nothing. galley pins the PVE certificate (or checks it against system roots). Cookies are `Secure`, `HttpOnly` and `SameSite=Lax`. Mutations need CSRF, JSON and a same-origin request. Logins are rate-limited. | Use a real TLS certificate on galley, or pin its self-signed one. |

## Mitigations and what each one buys

### Per-session envelope encryption of user credentials

- At login galley makes a random 32-byte session secret **K**. The cookie is `galley_session=<id>.<K>`.
  Clients should treat it as opaque.
- The database stores `sha256(id)`, a one-way verifier of K (HKDF, separate label), and the
  credentials. The credentials are sealed with AES-GCM under
  `HKDF-SHA256(secret = K, salt = instance key, info = "galley session credentials v1")`.
  Both K and the instance key are needed to open them. Each value is bound to its session, cluster
  and field (additional data), so sealed values cannot be moved between rows.
- A request whose cookie has the right id but the wrong K is not a session (`401`).
- **What it buys:** a copy of the database and the key file reveals no user's PVE login. That
  covers backups, snapshots, a stolen disk, and a passive compromise that only reads files. It
  also bounds the damage of a one-time memory read to the sessions in use at that moment.

### Credentials live only as long as someone is using them

- galley keeps K in memory only while a session is in use:
  - for 30 minutes after the session's last request;
  - while one of the session's live event streams (`/api/events`, an open tab) is connected;
  - while one of the session's changes is running. The run holds its own copy of K and renews its
    ticket until it finishes, even after the user goes idle (changes are capped at 4 hours).
- Background renewal (every 5 minutes) renews only tickets whose K is in memory.
- **Abandoned sessions lapse.** If K is not in memory, the 2-hour PVE ticket expires. The galley
  session itself stays valid until its own expiry. The next request (which brings K back) gets
  `409 cluster_login_required` for that cluster, and `GET /api/me` shows
  `"authed": false, "loginExpired": true` for it. The user enters their password for that cluster
  again (`POST /api/clusters/{id}/login`), without logging out.
- **After a restart** nothing can be decrypted until each user's next request brings K back.
  Sessions still survive restarts: a ticket that has not expired is renewed on that request.
- Logout deletes the session, its credentials and the K held in memory, and revokes tokens (see
  below).
- **What it buys:** galley no longer keeps every user's PVE identity alive indefinitely. Someone
  who gains root on the CT later gets only the users who are active from then on, not everyone who
  logged in during the last day.

### Session lifetime: 4 h idle, 12 h maximum (default)

Set with `--session-idle` (default `4h`) and `--session-max` (default `12h`). These were 8 h and
24 h before.

- 12 h covers a working day plus a long change. A session cannot outlive a day of absence, so a
  stolen cookie is good for half a day at most. Token mode creates tokens that expire with the
  session.
- 4 h idle covers lunch and meetings. A ticket left without renewal lapses after 2 h anyway (see
  above), so the idle limit mainly ends the galley session itself.
- Shorter values are safer. The cost is more logins. Values must satisfy idle ≤ max ≤ 168 h.

### Credential mode per cluster: `ticket` (default) or `token`

`PUT /api/clusters/{id} {"credentialMode":"token"}` needs a galley admin. It applies to new logins;
existing credentials keep working until they lapse.

In **`token` mode**, galley uses the login ticket once, right after login, to create an API token
for that user:

- name `galley-<random>`, `privsep=0` (the user's own permissions), comment `galley session`;
- `expire` set to the end of the session's maximum lifetime.

Then galley discards the ticket and stores only the token, sealed per session as above.

- **Pros:**
  - The token is visible in PVE (Datacenter → Permissions → API Tokens, or the user's own token
    list). The user or an administrator can revoke it there.
  - It expires on its own, even if galley never runs again.
  - Nothing is renewed, so there is no long-lived ticket to steal.
  - PVE's task log shows `user@realm!galley-…`.
- **Cons:**
  - Operations PVE reserves for a real `root@pam` *ticket* fail. Examples: raw `hostpci` devices
    without a resource mapping, and some root-only config options.
  - The PVE node terminal (host commands with the `pve` transport) is not a passwordless root shell
    for a token.
  - Console websockets with a token need a PVE version that accepts API tokens on `vncwebsocket`.
  - Tokens appear in the user's PVE account.
  - Only users with `User.Modify` can create agent tokens: PVE's "self" check compares the caller
    with the token's owner, and a token is not its user (verified on PVE 9.2).
- **Revocation:**
  - On logout galley tries to delete the token using the token itself. PVE may not let a token
    delete itself.
  - If that fails, or when a session expires unused (its K is gone, so the token cannot be read),
    galley records the token id in `token_revocations`. It deletes it with the user's next login
    ticket on that cluster, and writes `auth.token` entries in the audit log.
  - Either way, the token expires at the end of the session's maximum lifetime.
  - Removing a cluster from galley does not revoke tokens on it; they expire on their own.

### Host commands: the PVE node terminal by default, SSH opt-in

Before this change galley held one SSH private key per cluster, authorized as root on every node.
That key worked at any time, needed nobody's login, and could be decrypted with the data directory
alone. It was a bigger prize than any user's ticket.

The **`pve` transport** is now the default (`hostTransport`, per cluster). `host.exec` runs through
PVE's own node terminal, as the acting user:

1. `POST /nodes/{node}/termproxy` with the user's credential. PVE checks `Sys.Console`.
2. galley opens `vncwebsocket` over the pinned TLS connection, sends `<user>:<termproxy ticket>\n`,
   and waits for the login to finish.
3. It starts a history-free, prompt-less shell (`unset HISTFILE`, `stty -echo`) and waits for a
   random ready marker.
4. It types the command base64-encoded, in short lines, so the terminal interprets none of its
   characters and no line exceeds the tty limit. It then runs
   `echo BEGIN; bash -c "$(… | base64 -d)" </dev/null 2>&1; echo END $?; exit`.
5. Output between the markers (carriage returns removed, at most 256 KiB) and the exit status are
   recorded. The markers are typed as `GLY''<hex>`, so the terminal's echo of the input never
   matches them.
6. The whole command is limited to 30 minutes. The shell start is limited to 30 s. On timeout
   galley sends Ctrl-C and hangs up.

Consequences:

- **galley holds no root credential for host commands.** PVE authorizes every use, and the PVE
  task log records the terminal session under the real user.
- PVE gives a passwordless root shell **only to `root@pam`**. Other users get a `login:` prompt.
  galley detects the prompt, types nothing into it, and fails with a clear error. In practice,
  host commands need a session logged in as `root@pam` on that cluster. That is no new power:
  a `root@pam` ticket already opens the same shell in the PVE GUI.
- Terminal scraping is less exact than SSH: carriage returns are stripped, and the command runs
  under a pseudo-terminal (some tools change their output). If the shell does not start, the step
  fails.

The **`ssh` transport** (opt-in, galley admin, `PUT /api/clusters/{id} {"hostTransport":"ssh"}`)
keeps the earlier behaviour: a per-cluster key and pinned host keys. It allows non-root
administrators to run host commands, at the cost of a stored root credential. The key is created
only once SSH is enabled. Switching back to `pve` **deletes the key**. Remove the
`restrict ssh-ed25519 … galley` line from `/etc/pve/priv/authorized_keys` as well. Clusters that
already had an SSH key when upgrading keep `ssh` until an admin switches.

We considered and rejected keeping SSH but encrypting the key under an active host admin's K. With
that design the key still exists, it is still root for anyone who gets it, and it decrypts whenever
any admin is active. The node terminal removes the key altogether.

### Agent tokens (MCP and API access without the browser)

An agent token (`glly_…`) is an agent session: the secret that decrypts its stored credentials
travels only in the token, exactly like a browser cookie's. At creation galley mints one PVE API
token per cluster the user is logged in to (privilege-separation off: the user's own rights),
expiring with the agent token (1–90 days, independent of browser sessions and logout). Revoking
deletes those PVE tokens; if a cluster is unreachable the revocation is kept until the PVE token
would have expired and retried at the user's next login.

- Scopes: `read` (GET, metrics, user guide), `draft` (also drafts changes, at most 10 waiting per
  agent, kept 24 hours), `apply` (also applies changes, still passing the typed confirmation).
- Agent tokens never reach galley administration: clusters, settings, agent tokens, logins,
  consoles, the in-app assistant — directly or as a `galley.*` change (refused when drafted and
  when applied).
- Every change an agent drafts — over MCP or REST — is labelled "Agent draft (<name>)" and needs
  typed confirmation; the audit log records `via: agent:<name>` for changes an agent applied.
- Bearer tokens are not sent by browsers on their own, so agent requests skip the CSRF check;
  a token presented as a cookie, or a cookie presented as a token, is rejected.
- Risk: a leaked `apply` token can do whatever its user can do in PVE until it expires or is
  revoked. By default (`risky`) an agent applies only an allowlist of routine, reversible
  guest work (method, path and parameters; `routine` in `internal/server/approval.go`); everything
  else is refused when an agent applies it, however and by whomever it was drafted, and the draft
  waits for the user's browser session. `hosts` refuses only host commands and calls that open
  another way in (`/access`, node shells, `execute`, `apt`, `/cluster/config`). A galley admin
  can also set `all` or `always` (`PUT /api/settings/agents`, audited as `settings.agents`, never
  available to agents). An unreadable value means `risky`. PVE itself refuses API tokens a root node terminal,
  so root commands by an agent also need the SSH transport. The refusal of host commands that name
  secret files is a pattern check that can be worded around. Prefer `draft`, short lifetimes, and a dedicated PVE user with narrow ACLs for agents.

### Unchanged controls

- Every read shown to a user is filtered by that user's PVE permissions.
- Every change runs with the user's credential and is audited before it is sent.
- CSRF token, JSON-only, same-origin mutations.
- Login rate limits per IP and per user.
- OIDC flows are bound to the starting browser.
- `--admin` is qualified by cluster.
- The read-only service token is checked at registration.
- Security headers.

## Residual risk

- **Live root on the galley host can act as active users.** An attacker who controls the galley
  process can read K from requests and memory, or simply wait for logins. They get every user who
  is active, or who logs in, while they are present. That includes `root@pam` if an
  administrator uses galley, and through the node terminal that means root on the nodes. No design
  of a server that acts for its users avoids this.
- To reduce it:
  - Keep the galley CT minimal and patched.
  - Restrict who can reach it (VPN, firewall).
  - Prefer non-root accounts with scoped roles for daily work, and use `root@pam` only when needed.
  - Use `credentialMode: "token"` where root-ticket operations are not needed, so stolen
    credentials expire and can be revoked in PVE.
  - Use short `--session-max` values.
- **Instance key + database** still expose the read-only service tokens (the cluster inventory),
  the assistant API key and, if SSH is enabled, the SSH key. Protect backups of `<data>`.
- **Stolen browser cookie:** it carries K, so it is equivalent to the session until it expires
  (12 h by default) or the user logs out. Logging out invalidates it on the server.
- **Token mode revocation** depends on the user logging in again, or on the token's own expiry, if
  PVE refuses self-deletion.
- **Host-command output** is stored in the audit log in plain text. It is visible to the actor and
  to holders of `Sys.Audit`. Do not print secrets.
- **The assistant** sends the data its tools read to the configured model provider (shown as
  `dataNotice`). It can only draft changes.
