---
id: cluster/02-base-os
title: Base OS — repositories, hosts, sysctl, packages, upgrade
tested: "PVE 9.2 · Ceph 19.2 (squid) · 3-node HCI · 2026-11"
risk: low
runs_on: operator
automated_by: scripts/pvecb base-os
---

# Base OS — repositories, hosts, sysctl, packages, upgrade

Bring every node to the same package level and baseline config: correct
repositories for the subscription state, a managed `/etc/hosts` block listing every
node, network and memory sysctls, admin tools, and a full upgrade. Do this before
clustering so all nodes run identical versions of corosync, knet and pve-cluster.

## Preconditions

- Preflight passed.
- Nodes can reach `download.proxmox.com` and Debian mirrors over HTTP.

## Inputs

| Inventory key / variable | Meaning | Example |
|---|---|---|
| `cluster.repos` | `no-subscription` or `enterprise` | `no-subscription` |
| `cluster.domain` | FQDN suffix written to `/etc/hosts` | `example.internal` |
| `cluster.timezone` | Optional timezone | `UTC` |
| `nodes[].backend_ip` | Added to hosts as `<node>-backend` | `10.15.15.11` |

## Steps

1. Automated:

   ```bash
   scripts/pvecb base-os
   ```

2. Manual equivalent, per node:

   ```bash
   # repositories (no subscription): disable enterprise, add no-subscription
   mv /etc/apt/sources.list.d/pve-enterprise.sources{,.disabled}
   cat > /etc/apt/sources.list.d/proxmox.sources <<'EOF'
   Types: deb
   URIs: http://download.proxmox.com/debian/pve
   Suites: trixie
   Components: pve-no-subscription
   Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
   EOF
   cat > /etc/apt/sources.list.d/ceph.sources <<'EOF'
   Types: deb
   URIs: http://download.proxmox.com/debian/ceph-squid
   Suites: trixie
   Components: no-subscription
   Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
   EOF

   # /etc/hosts — every node, on every node
   cat >> /etc/hosts <<'EOF'
   # BEGIN pve-cookbook (managed)
   192.0.2.11 pve1.example.internal pve1
   192.0.2.12 pve2.example.internal pve2
   192.0.2.13 pve3.example.internal pve3
   10.15.15.11 pve1-backend
   10.15.15.12 pve2-backend
   10.15.15.13 pve3-backend
   # END pve-cookbook
   EOF

   # sysctl (see scripts/steps/base-os.sh for the full file)
   printf 'vm.swappiness = 10\nnet.core.rmem_max = 67108864\nnet.core.wmem_max = 67108864\n' \
     > /etc/sysctl.d/90-pve-cookbook.conf && sysctl --system

   apt-get update && apt-get -y full-upgrade
   apt-get -y install chrony ethtool lldpd nvme-cli smartmontools sysstat iperf3 tcpdump jq
   ```

3. If a newer kernel was installed (`pvecb` prints `new kernel installed on: …`),
   reboot those nodes now, while nothing is clustered yet:

   ```bash
   ssh root@pve1 'systemd-run --on-active=3 systemctl reboot'
   # wait until it answers again and runs the newest kernel:
   ssh root@pve1 'uname -r; ls /boot/vmlinuz-* | sort -V | tail -1'
   ```

## Verify

```bash
apt-get update 2>&1 | grep -cE '^(E|Err):'   # 0
pveversion                                    # identical on every node
uname -r                                      # equals the newest /boot/vmlinuz-*
getent hosts pve2 pve3-backend                # resolves
```

## Rollback

- Repos: `mv /etc/apt/sources.list.d/pve-enterprise.sources.disabled /etc/apt/sources.list.d/pve-enterprise.sources` and delete `proxmox.sources`.
- Hosts: delete the `# BEGIN pve-cookbook` … `# END pve-cookbook` block.
- Sysctl: `rm /etc/sysctl.d/90-pve-cookbook.conf && sysctl --system`.
- Package upgrades are not rolled back. Boot the previous kernel from the boot menu if needed.

## Gotchas

- **Reboot before clustering, not after.** Rebooting a fresh cluster node is fine,
  but doing it while nothing is clustered costs nothing and validates the boot path.
- **Mixed versions across nodes** cause subtle corosync/knet incompatibilities.
  Upgrade every node in the same pass.
- **Hostname must match the inventory name.** PVE derives node identity from
  `hostname -s`. Renaming after clustering is painful.
