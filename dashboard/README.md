# galley — a cockpit for Proxmox VE admins

> Status: **MVP** — fleet overview, guest inventory with bulk actions, ⌘K command palette,
> plan pane with CLI equivalents, operations/task log, audit log, multi-cluster
> registration with TLS pinning, a built-in assistant, an MCP server for AI agents, and an in-app user guide (Help).

galley is a single, self-hosted web app (one Go binary in a small LXC) for running one or
many Proxmox VE clusters. It does **not** replace the PVE GUI or
[Proxmox Datacenter Manager](https://pve.proxmox.com/wiki/Proxmox_Datacenter_Manager); it
covers what they make slow: fleet-wide views, guided workflows, fast provisioning, drift
detection, and safe bulk operations. Deep, rarely used settings link out to the native GUI.

## Principles

1. **Admin-first.** Dense, keyboard-driven (⌘K command palette), PVE terminology everywhere.
2. **No parallel permission system.** You log in with PVE credentials (any realm: PAM, PVE,
   OpenID Connect via a PVE `openid` realm). galley reads and writes as you, so you only see
   what your PVE permissions allow, and PVE's task log shows the real user.
3. **Every write is a plan first.** Mutations show the exact API calls and the equivalent
   `pvesh`/`qm`/`pct` command, require typed confirmation when destructive, and are written
   to a copyable audit log. The admin always learns the CLI and can reproduce the action.
4. **API-first.** The UI uses the same documented REST API ([docs/api.md](docs/api.md)) that
   scripts use. AI agents can drive galley directly over MCP (`/mcp`, or `galley mcp` over stdio) with scoped agent tokens — see [docs/user/agents-and-mcp.md](docs/user/agents-and-mcp.md).
5. **Light.** No embedded time-series database. Live state comes from the PVE API (polled about every 5 s
   per cluster, pushed to browsers via SSE). Long-term metrics are handled by the monitoring
   recipes.

## Run it

```bash
# Try it without Proxmox: an in-process fake cluster (log in as root / secret)
cd dashboard && make web build && ./galley --demo --insecure-http --listen 127.0.0.1:8080

# On a real cluster: run on any PVE node; creates an unprivileged Debian LXC and
# downloads the release binary (sha256-verified against the release's SHA256SUMS)
bash <(curl -fsSL https://github.com/JongoDB/pve-cookbook/releases/latest/download/galley-lxc.sh) \
  --id 150 --storage vm-pool --bridge vmbr0 --ip dhcp --create-token
# a specific (or pre-release) version:  … galley-lxc.sh --version v0.1.0-rc.1 …
# upgrade an existing galley CT in place (sha256-verified download, or --binary PATH):
#   … galley-lxc.sh --upgrade --id 150 [--version vX.Y.Z]

# Or just the binary, anywhere with network access to the cluster (Linux amd64/arm64).
# Minimal images (e.g. the Debian 13 LXC template) need: apt-get install -y curl ca-certificates
curl -fsSLO https://github.com/JongoDB/pve-cookbook/releases/latest/download/galley-linux-amd64
curl -fsSLO https://github.com/JongoDB/pve-cookbook/releases/latest/download/SHA256SUMS
sha256sum --ignore-missing -c SHA256SUMS && install -m 0755 galley-linux-amd64 /usr/local/bin/galley
galley --listen :8443 --data /var/lib/galley
```

`--create-token` creates `galley@pve` with `PVEAuditor` on `/` and the token `galley@pve!poller`
(the read-only poller credential) and prints the secret once. The installer also prints a
one-time **setup code** (galley writes it to `/var/lib/galley/setup-token` on first start, and
logs it to `journalctl -u galley`); registering the first cluster requires it. Open the printed
URL, enter the setup code, add the cluster's node addresses, confirm their certificate
fingerprints, paste the token, then log in with your normal PVE account. Every change you make
in galley runs as **you**.

Development: `cd dashboard/web && npm run dev:mock` (UI only, mock API) or `npm run dev`
(proxies `/api` to a local `galley --insecure-http --listen 127.0.0.1:8443`). Tests:
`make test`. API contract: [`docs/api.md`](docs/api.md).

## Architecture

```text
browser ──HTTPS/SSE──► galley (Go, SQLite) ──HTTPS :8006──► cluster A (endpoints pve1,pve2,pve3; TLS pinned)
   ▲                      │  │                        └──► cluster B …
   └── React/TS SPA ◄─────┘
```

- Per cluster: several API endpoints with automatic failover, and TLS fingerprints pinned on first use and confirmed by the admin.
- Credentials: a read-only `PVEAuditor` service token per cluster for the shared cache, and each user's own PVE login (a ticket, or optionally a short-lived personal API token) for everything shown to and done by that user. Stored logins are encrypted with a key that only exists in the user's browser cookie and in memory while they are active, so a stolen database or backup reveals nothing usable; idle logins lapse. Host commands run through PVE's own node terminal as the user by default — galley holds no root credential. See [docs/security.md](docs/security.md).
- SQLite (versioned migrations): cluster registry, pinned fingerprints, sessions, audit log, per-user preferences. Back up `/var/lib/galley` as a whole: `secret.key` decrypts the stored secrets.

## Features and roadmap

The user guide ([docs/user](docs/user), also the **Help** page in galley) describes what ships today; this list includes planned items.

### Fleet and health

- Multi-cluster overview: nodes, quorum, Ceph, storage fill, HA state and alerts on one screen
- Health and drift checks (the same check IDs as `scripts/pve-health.sh`): repos, pending updates and reboots, flow control, a single corosync link, stray udevd, Ceph flags, certificates, time sync, unprotected guests
- Guest inventory across clusters: tags, filters, search, and bulk start/stop/migrate/snapshot

### Provisioning

- **App catalog:** search community-scripts, choose node/storage/vnet, deploy unattended, watch the live log (wraps `scripts/pve-app.sh` semantics)
- **Quick create:** a VM or LXC from saved profiles (cloud-init image, SSH key, vnet, size preset) in one step
- **Custom builder:** a full VM/LXC editor with CPU type and topology, NUMA, memory and ballooning, hugepages, disks (bus, cache, iothread, storage), NICs (vnet/bridge, VLAN, firewall, rate limit), cloud-init, boot order, machine/BIOS (q35/OVMF), TPM, startup order and HA. It always shows the resulting `qm create`/`pct create` command
- **Host resource passthrough and virtualization:**
  - discovery of GPUs, accelerators (e.g. QAT), NVMe, NICs and USB per node, including IOMMU group isolation and current driver (vfio-pci / nvidia / i915 …)
  - full PCIe passthrough to VMs via cluster-wide **resource mappings** (`hostpci0: mapping=…`), with checks for q35/OVMF and ballooning
  - **shared GPU for LXCs** (`devN: /dev/dri/renderD*`, NVIDIA device nodes) so several inference containers can share one card
  - vGPU / SR-IOV / mediated devices where the hardware and licence allow it (shown as capabilities, never assumed)
  - placement that respects reality: a guest using a mapped device can only run on nodes that have it, (planned: galley creating the matching HA node-affinity rule; today the user guide lists the rule to add)
  - **"LLM server" preset:** pick a GPU, model size and engine (Ollama / vLLM / llama.cpp). galley sets up the VM (passthrough) or LXC (shared GPU) hardware for it (planned: VRAM fit and installing the engine)

### Identity and access

- Users, groups, roles, ACLs and API tokens, with a "who can do what, where" matrix and 2FA status

### Network and security

- SDN: zones, vnets, subnets and IPAM leases, plus creating a vnet
- Firewall: rules per level, ipset editor, and a "why is this blocked?" check

### Backup and DR

- Backup jobs, last result per guest, the unprotected-guest list, and one-click restore to a new VMID for testing

### Operations

- Rolling updates (drain → `noout` → upgrade → reboot → verify → next), node maintenance mode, and a cross-cluster task/event log

## v2 candidates

Capacity trends, stacks (several guests deployed together), an OIDC/LDAP setup wizard, a topology map,
scheduled automatic restore checks, and running cookbook recipes from the UI.

## Delivery

- One-line installer in the style of community-scripts, run on any PVE node: it creates an unprivileged
  Debian LXC (1 vCPU, 512 MB), installs the binary, generates TLS and prints the URL.
- CI runs against a fake PVE API (fixtures recorded from PVE 9 with identifying data
  scrubbed). Opt-in live tests only touch VMIDs 99000–99999.
