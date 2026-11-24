---
title: Install and upgrade
summary: Install galley in a container on a PVE node, register the first cluster, set startup options, upgrade, and back up galley's data.
order: 20
---

galley is one program. The usual way to run it is the installer script, which creates a small unprivileged Debian container on a PVE node and runs galley in it as a systemd service. You need root on a PVE node to run the installer.

## Install with the installer

Run this on any node of the cluster, as root:

```bash
bash <(curl -fsSL https://github.com/JongoDB/pve-cookbook/releases/latest/download/galley-lxc.sh) \
  --id 150 --storage vm-pool --bridge vmbr0 --ip dhcp --create-token
```

The installer:

1. Checks that the container ID is free anywhere in the cluster.
2. Downloads the galley release for the node's architecture and verifies its SHA-256 checksum against the release's `SHA256SUMS`.
3. Downloads the Debian 13 standard container template if the node does not have it.
4. Creates an unprivileged container (1 core, 512 MiB memory, 256 MiB swap, 4 GiB root disk, nesting on, starts at boot, tag `galley`).
5. Installs galley as `/usr/local/bin/galley` with the service `galley.service`, running as the user `galley`, listening on port 8443, with its data in `/var/lib/galley`.
6. With `--create-token`, creates the PVE user `galley@pve` with the `PVEAuditor` role on `/` and the API token `galley@pve!poller`.
7. Prints the address, galley's TLS certificate fingerprint, the one-time setup code and, with `--create-token`, the token secret. The secret is shown only once; copy it.

### Installer options

- `--id N`: container ID. Required.
- `--storage NAME`: storage for the container's root disk. Required when the node has more than one candidate.
- `--bridge NAME`: bridge or SDN VNet. Default `vmbr0`.
- `--ip dhcp|CIDR`: default `dhcp`. With a static address, add `--gw IP` and optionally `--dns IP`.
- `--hostname NAME`: default `galley`.
- `--version vX.Y.Z`: install this release instead of the latest, including pre-releases.
- `--binary PATH`: install this galley binary instead of downloading one.
- `--create-token`: create the read-only service user and token (see above).
- `--ssh-key FILE`: authorize this public key for root in the container.
- `--upgrade`: upgrade an existing galley container (see below).

## Register the first cluster

The first time you open galley, it shows **Connect your first cluster**. No one can log in until a cluster is registered.

1. Open the URL the installer printed, for example `https://192.0.2.50:8443`. galley uses a self-signed certificate by default; compare the fingerprint your browser shows with the one the installer printed.
2. Enter the **Setup code**. The installer printed it. It is also in `/var/lib/galley/setup-token` in the container, and in `journalctl -u galley`.
3. Under **API endpoints**, enter every node of the cluster, one per line. Port 8006 is used unless you add another, for example `192.0.2.12:8006`.
4. Select **Probe endpoints**. galley connects to each node and shows its certificate.
5. For each endpoint, compare the **SHA-256 fingerprint** with the output of `pvenode cert info` on that node, then tick **Trust**. Endpoints with a certificate from a public authority show **Valid public certificate** and are ticked already.
6. Enter a **Cluster name**, the **Service token ID (read-only, PVEAuditor)**, for example `galley@pve!poller`, and the **Token secret**.
7. Select **Add cluster with N endpoints**.
8. Log in with your normal PVE account. See [Getting started](getting-started.md#log-in).

The setup code works once: galley deletes it when the first cluster is registered. After that, only galley admins can add clusters; see [Clusters and access](clusters-and-access.md).

### The service token

galley reads each cluster's state in the background with a read-only API token. Everything you see is then filtered by your own permissions, and every change runs as you, never as the token.

galley refuses a token that holds any write privilege (for example `Sys.Modify`, `VM.PowerMgmt` or `VM.Allocate`), and requires `Sys.Audit` on `/`. The `PVEAuditor` role on `/` fits exactly. If you did not use `--create-token`, create it on any node:

```bash
pveum user add galley@pve
pveum acl modify / --users galley@pve --roles PVEAuditor
pveum user token add galley@pve poller --privsep 0
```

## Upgrade

Run this on the node that hosts the galley container:

```bash
bash <(curl -fsSL https://github.com/JongoDB/pve-cookbook/releases/latest/download/galley-lxc.sh) \
  --upgrade --id 150
```

- Add `--version vX.Y.Z` for a specific release, or `--binary PATH` for a binary you built.
- The container must be running.
- The installer verifies the download, checks that the new binary starts, replaces `/usr/local/bin/galley`, restarts the service, and prints the old and new versions.
- Your data, settings and any service options you set stay as they are.

If the service does not come back, check its log with `pct exec 150 -- journalctl -u galley -n 50`.

While galley stops, changes that are running get up to 60 seconds to finish. Changes still running after that are marked **Failed** in the audit log, with a note to check the PVE task log.

## Set startup options

The installer starts galley with `--listen :8443 --data /var/lib/galley`. To add options, override the service's start command inside the container:

1. Open a shell in the container, for example with `pct enter 150`.
2. Run `systemctl edit galley` and add:

   ```ini
   [Service]
   ExecStart=
   ExecStart=/usr/local/bin/galley --listen :8443 --data /var/lib/galley --public-url https://galley.example.com
   ```

3. Run `systemctl restart galley`.

The override survives upgrades, because `--upgrade` replaces only the binary.

### Options

- `--listen ADDR`: address and port. Default `:8443`.
- `--data DIR`: data directory. Default `/var/lib/galley`.
- `--tls-cert FILE` and `--tls-key FILE`: your own certificate. Without them galley creates a self-signed certificate (valid for 5 years) in the data directory.
- `--public-url URL`: galley's external address, for example `https://galley.example.com`. Needed for single sign-on.
- `--admin cluster:user@realm`: make this user a galley admin while logged in to that cluster as that user. Repeat for more admins. See [Clusters and access](clusters-and-access.md#galley-admins).
- `--session-idle DURATION`: end a session after this long without requests. Default `4h`.
- `--session-max DURATION`: end a session this long after login, however active. Default `12h`. Idle must not exceed max, and max must not exceed `168h`.
- `--poll DURATION`: how often galley reads each cluster. Default `5s`.
- `--insecure-http`: serve plain HTTP. For development only.
- `--demo`: register an in-process fake cluster to try galley without PVE. Log in as `root`, password `secret`, realm `pam`. Data is temporary.
- `--version`: print the version and exit.

## Set up single sign-on

galley uses PVE's own OpenID Connect realms. There is nothing to configure in galley besides its public address.

1. In PVE, create an OpenID Connect realm (Datacenter, Permissions, Realms) if you do not have one.
2. In your identity provider, allow `https://<galley-host>/api/login/openid/callback` as a redirect URI for that realm's client.
3. Start galley with `--public-url https://<galley-host>` (see [Set startup options](#set-startup-options)).
4. The login page now shows **Sign in with <realm>** for that cluster.

## Run the binary without the installer

galley also runs on any Linux machine (amd64 or arm64) that can reach the clusters on port 8006:

```bash
curl -fsSLO https://github.com/JongoDB/pve-cookbook/releases/latest/download/galley-linux-amd64
curl -fsSLO https://github.com/JongoDB/pve-cookbook/releases/latest/download/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS && install -m 0755 galley-linux-amd64 /usr/local/bin/galley
galley --listen :8443 --data /var/lib/galley
```

Minimal images (for example the Debian 13 container template) need `apt-get install -y curl ca-certificates` first. The setup code is written to `<data>/setup-token` and to the log.

## Back up galley

Back up the data directory, `/var/lib/galley`, as a whole. It holds:

- `galley.db`: the cluster registry, pinned certificates, sessions, audit log and preferences.
- `secret.key`: the key that decrypts the stored secrets (service tokens, assistant API key, SSH key if you enabled SSH).
- `tls.crt` and `tls.key`: the self-signed certificate.

Keep `secret.key` with the database. Without it galley cannot decrypt the service tokens; the Clusters page then says **The stored token secret cannot be decrypted**, and you must remove and add each cluster again.

Protect these backups: together, `galley.db` and `secret.key` reveal the read-only service tokens, the assistant API key and, if SSH is enabled, galley's SSH key. They never reveal users' PVE logins. See [Security](security.md).

A backup of the whole container (vzdump) covers the data directory.
