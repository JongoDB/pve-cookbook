# summary: repos, /etc/hosts, sysctl, base packages, full-upgrade
# shellcheck shell=bash

_base_os_node() {
  local repos="$1" hosts_block="$2" tz="$3"
  export DEBIAN_FRONTEND=noninteractive
  # --- repositories (deb822, PVE 9 / trixie)
  local d=/etc/apt/sources.list.d
  if [[ "$repos" == "no-subscription" ]]; then
    for f in "$d/pve-enterprise.sources" "$d/ceph.sources"; do
      [[ -f "$f" ]] && grep -q enterprise.proxmox.com "$f" && mv "$f" "$f.disabled" && echo "disabled $f"
    done
    cat >"$d/proxmox.sources" <<'R'
Types: deb
URIs: http://download.proxmox.com/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
R
    cat >"$d/ceph.sources" <<'R'
Types: deb
URIs: http://download.proxmox.com/debian/ceph-squid
Suites: trixie
Components: no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
R
  fi
  # --- /etc/hosts: managed block, everything else preserved
  local tmp; tmp="$(mktemp)"
  awk '/^# BEGIN pve-cookbook/{skip=1} !skip{print} /^# END pve-cookbook/{skip=0}' /etc/hosts \
    | grep -vE "^[0-9.]+[[:space:]]+$(hostname -s)(\.|[[:space:]]|$)" >"$tmp"
  { echo "# BEGIN pve-cookbook (managed)"; printf '%s\n' "$hosts_block"; echo "# END pve-cookbook"; cat "$tmp"; } >/etc/hosts
  rm -f "$tmp"
  # --- sysctl
  cat >/etc/sysctl.d/90-pve-cookbook.conf <<'S'
vm.swappiness = 10
vm.min_free_kbytes = 1048576
net.core.rmem_max = 67108864
net.core.wmem_max = 67108864
net.ipv4.tcp_rmem = 4096 87380 33554432
net.ipv4.tcp_wmem = 4096 65536 33554432
net.core.netdev_max_backlog = 30000
net.ipv4.tcp_mtu_probing = 1
fs.inotify.max_user_watches = 1048576
fs.inotify.max_user_instances = 8192
S
  sysctl -q --system
  [[ -n "$tz" ]] && timedatectl set-timezone "$tz"
  # --- packages
  apt-get -qq update
  apt-get -y -qq -o Dpkg::Options::=--force-confold full-upgrade >/dev/null
  apt-get -y -qq install chrony ethtool lldpd nvme-cli smartmontools sysstat iperf3 tcpdump jq >/dev/null
  local newest; newest="$(find /boot -maxdepth 1 -name 'vmlinuz-*' -printf '%f\n' | sed 's/vmlinuz-//' | sort -V | tail -1)"
  echo "pve $(pveversion | cut -d/ -f2), running $(uname -r), newest installed $newest"
  [[ "$newest" == "$(uname -r)" ]] || echo "REBOOT_NEEDED"
}

step_base_os() {
  local hosts="" n d; d="$(q cluster.domain)"
  for n in $(nodes); do hosts+="$(node_field "$n" mgmt_ip) $n.$d $n"$'\n'; done
  for n in $(nodes); do
    local b; b="$(node_field "$n" backend_ip '')"; [[ -n "$b" ]] && hosts+="$b $n-backend"$'\n'
  done
  local need_reboot=()
  for n in $(nodes); do
    info "--- $n"
    local out; out="$(on_fn "$n" _base_os_node "$(q cluster.repos no-subscription)" "${hosts%$'\n'}" "$(q cluster.timezone '')")"
    info "$out"
    grep -q REBOOT_NEEDED <<<"$out" && need_reboot+=("$n")
  done
  ((${#need_reboot[@]} == 0)) || warn "new kernel installed on: ${need_reboot[*]} — reboot before clustering (see recipes/cluster/01-base-os.md)"
}
