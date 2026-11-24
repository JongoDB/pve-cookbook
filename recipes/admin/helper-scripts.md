---
id: admin/helper-scripts
title: Deploy apps with community-scripts (unattended)
tested: "PVE 9.2 · community-scripts ProxmoxVE@5943838 + core@d1cec87 · 2026-11 (catalog search/info verified; CT deploy path verified)"
risk: low
runs_on: node
automated_by: scripts/pve-app.sh
---

# Deploy apps with community-scripts

[community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE) (MIT, the project that
continues tteck's Proxmox helper scripts) has 400+ installers for LXC containers and VMs. This cookbook
**references them upstream and never vendors them**. `scripts/pve-app.sh` wraps them so they run
unattended, with explicit IDs, storage and network, and with telemetry off by default.

## Preconditions

- Run on a PVE node with internet access: `curl -fsI https://raw.githubusercontent.com >/dev/null`
- Target vnet applied on that node: `ip link show servers`
- Free ID in your chosen range: `pct status 110 2>&1 | grep -q 'does not exist'`

## Inputs

| Flag | Upstream variable | Notes |
|---|---|---|
| `--id N` | `var_ctid` / `VM_VMID` | **Required.** Upstream silently moves a taken CT ID to the next free one; the wrapper refuses instead |
| `--storage S` | `var_container_storage` / `VM_STORAGE` | Required if more than one candidate storage exists |
| `--template-storage S` | `var_template_storage` | Defaults to the first storage with `vztmpl` content; prefer `cephfs` |
| `--vnet V` | `var_sdn_vnet` | Preferred over `--bridge` (`var_brg`, default `vmbr0`) |
| `--ip CIDR\|dhcp` `--gw` `--dns` | `var_net`, `var_gateway`, `var_ns` | |
| `--cpu --ram --disk` | `var_cpu`, `var_ram` (MiB), `var_disk` (GiB) | Floored at the app's declared minimums |
| `--ssh-key FILE` | `var_ssh=yes`, `var_ssh_authorized_key` | Root key inside the container |
| `--os --os-version` | `var_os`, `var_version` | e.g. `debian 13`, `alpine 3.24` |
| `--set K=V` | any app var | e.g. `var_docker_compose=yes` (see `info`) |
| `--pin PVE_SHA:CORE_SHA` | `COMMUNITY_SCRIPTS_URL`, `COMMUNITY_SCRIPTS_CORE_URL` | Pins **both** repos |
| `--telemetry` | `/usr/local/community-scripts/diagnostics` | Opt in; default writes `DIAGNOSTICS=no` |

## Steps

1. Install the wrapper on a node (or run it from a checkout):

   ```bash
   curl -fsSL -o /usr/local/bin/pve-app https://raw.githubusercontent.com/JongoDB/pve-cookbook/main/scripts/pve-app.sh
   chmod +x /usr/local/bin/pve-app
   ```

2. Find an app and read its options:

   ```bash
   pve-app search kuma
   pve-app info uptimekuma
   pve-app info docker        # shows --set var_docker_compose / var_docker_socket
   ```

3. Preview the exact command (nothing is changed):

   ```bash
   pve-app deploy uptimekuma --id 110 --vnet servers --ip 10.10.10.50/24 --gw 10.10.10.1 \
     --dns 1.1.1.1 --storage vm-pool --template-storage cephfs --dry-run
   ```

4. Deploy:

   ```bash
   pve-app deploy uptimekuma --id 110 --hostname kuma --vnet servers \
     --ip 10.10.10.50/24 --gw 10.10.10.1 --dns 1.1.1.1 \
     --storage vm-pool --template-storage cephfs --ssh-key ~/.ssh/id_ed25519.pub
   ```

5. VM scripts work the same way. The wrapper sets `VM_UNATTENDED=1` and `VM_VMID`, `VM_HOSTNAME`,
   `VM_STORAGE`, `VM_BRIDGE`, `VM_CORES`, `VM_RAM`, `VM_DISK_SIZE`:

   ```bash
   pve-app deploy debian-vm --id 130 --bridge servers --storage vm-pool --cpu 2 --ram 4096 --disk 32
   ```

6. Reproducible installs: pin to commits of **both** upstream repos.

   ```bash
   pve-app deploy docker --id 111 --storage vm-pool --vnet servers --ip dhcp \
     --set var_docker_compose=yes --set var_docker_socket=n \
     --pin <ProxmoxVE-sha>:<core-sha>
   ```

### How it works underneath

The wrapper calls `bash -c "$(curl -fsSL $COMMUNITY_SCRIPTS_URL/ct/<slug>.sh)"` with:

```bash
mode=generated PHS_SILENT=1 TERM=xterm \
var_ctid=110 var_hostname=kuma var_unprivileged=1 \
var_container_storage=vm-pool var_template_storage=cephfs \
var_sdn_vnet=servers var_net=10.10.10.50/24 var_gateway=10.10.10.1 var_ns=1.1.1.1 \
COMMUNITY_SCRIPTS_URL=https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main \
COMMUNITY_SCRIPTS_CORE_URL=https://raw.githubusercontent.com/community-scripts/core/main
```

- `mode=generated` is the upstream unattended mode. `default`/`mydefaults` can still open a storage
  picker when `default.vars` lacks storage keys.
- `PHS_SILENT=1` stops menus that read `/dev/tty` (e.g. OS choice).
- The catalog comes from the public PocketBase API:
  `https://db.community-scripts.org/api/collections/script_scripts/records?perPage=500&expand=type`.

## Verify

```bash
pct status 110                         # running
pct exec 110 -- hostname -I            # expected IP
pve-app info uptimekuma | head -1      # shows port=3001 → browse http://10.10.10.50:3001
```

## Rollback

```bash
pct stop 110 && pct destroy 110 --purge 1      # or: qm stop 130 && qm destroy 130 --purge 1
```

## Gotchas

- **Pinning only the ProxmoxVE SHA does not pin anything that matters.** Scripts load the engine
  (`build.func`) from `community-scripts/core@main` unless `COMMUNITY_SCRIPTS_CORE_URL` is also pinned.
  Pinned URLs are written into the guest's `/usr/bin/update`, so later updates stay pinned.
- Apps themselves are fetched from their upstream latest release unless `var_appversion` is set.
- Even with telemetry off, each run contacts `db.community-scripts.org` (to refuse disabled or deleted
  scripts), GitHub release APIs, and template/image mirrors.
- Telemetry: upstream asks interactively on first run. The wrapper pre-writes
  `/usr/local/community-scripts/diagnostics` with `DIAGNOSTICS=no` unless `--telemetry` is passed.
- Upstream exit code 209 means container creation failed; read `/tmp/pct_create_<id>_*.log` on the node.
- Scripts are third-party code running as root on your hypervisor. Read the script (`ct/<slug>.sh` and
  `install/<slug>-install.sh`) before first use and pin versions in production.
- Upstream licence: MIT, © tteck and the community-scripts organisation. Keep the attribution.
