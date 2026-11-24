---
name: pve-cookbook
description: Build, operate, and troubleshoot Proxmox VE clusters safely — cluster creation, Ceph, ZFS, SDN/EVPN, firewall, HA, backups, users/roles, GPU passthrough, community-scripts app deploys, health checks, rolling updates. Use whenever the task involves Proxmox VE (pve, pvesh, qm, pct, pveceph, corosync, pmxcfs) hosts or guests.
---

# pve-cookbook

You have a cookbook of tested Proxmox VE recipes and tools at `${CLAUDE_PLUGIN_ROOT}`.

1. Read `${CLAUDE_PLUGIN_ROOT}/AGENTS.md` first — it has the golden rules and a routing table.
2. Open only the recipe(s) the routing table points to under `${CLAUDE_PLUGIN_ROOT}/recipes/`.
3. Follow each recipe's **Preconditions → Steps → Verify**. Do not claim success until Verify passes.
4. Prefer the tools over hand-typed commands:
   - `${CLAUDE_PLUGIN_ROOT}/scripts/pvecb` — idempotent cluster build steps from an inventory
     (`pvecb list`, `--dry-run`, `-i inventory.yaml`). Copy `inventory.example.yaml` next to the
     user's work, fill it from `pvecb preflight` facts, and show it to the user before mutating steps.
   - `${CLAUDE_PLUGIN_ROOT}/scripts/pve-health.sh` — copy to a node and run (read-only; `--json`).
   - `${CLAUDE_PLUGIN_ROOT}/scripts/pve-app.sh` — copy to a node; unattended app deploys.
5. Ask the user before anything destructive (disk wipes, guest destroy, node removal, DROP firewall policy).
6. Use VMIDs 99000–99999 for any test guests and remove them afterwards.

If something hangs or fails in a way the recipe doesn't cover, check
`${CLAUDE_PLUGIN_ROOT}/recipes/troubleshooting/` before improvising — several failure modes
(pmxcfs wedges, SFP-10G-T packet loss, stray initramfs udevd) look like something else.
