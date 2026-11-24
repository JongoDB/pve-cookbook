# summary: datacenter firewall (ipsets, host security group) with dead-man auto-revert
# shellcheck shell=bash
#
# Enabling a DROP policy remotely can lock you out. We arm a systemd timer on the
# founder that disables the firewall after 180s, verify access from here, then disarm.

step_firewall() {
  is_true "$(q firewall.enabled false)" || { info "firewall disabled in inventory"; return 0; }
  local f n; f="$(founder)"
  local mg_cidrs; mg_cidrs="$(q 'firewall.management_cidrs[*]')"
  local backend; backend="$(q network.backend.cidr)"
  local script='
    ipset_has() { pvesh get /cluster/firewall/ipset --output-format json | grep -q "\"name\":\"$1\""; }
    cidr_add()  { pvesh get /cluster/firewall/ipset/$1 --output-format json | grep -q "\"cidr\":\"$2\"" || pvesh create /cluster/firewall/ipset/$1 --cidr "$2"; }
    ipset_has management      || pvesh create /cluster/firewall/ipset --name management --comment "Admin networks (GUI/SSH/console)"
    ipset_has cluster-backend || pvesh create /cluster/firewall/ipset --name cluster-backend --comment "Ceph/corosync/EVPN/migration"
    ipset_has cluster-nodes   || pvesh create /cluster/firewall/ipset --name cluster-nodes --comment "Node management IPs"
  '
  local c; for c in $mg_cidrs; do script+="cidr_add management $c"$'\n'; done
  script+="cidr_add cluster-backend $backend"$'\n'
  for n in $(nodes); do script+="cidr_add cluster-nodes $(node_field "$n" mgmt_ip)"$'\n'; done
  script+='
    if ! pvesh get /cluster/firewall/groups --output-format json | grep -q "\"group\":\"pve-hosts\""; then
      pvesh create /cluster/firewall/groups --group pve-hosts --comment "Baseline for Proxmox hosts"
      pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --source +cluster-backend --enable 1 --comment "Node-to-node backend"
      pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --source +cluster-nodes --enable 1 --comment "Node-to-node mgmt (corosync link, API)"
      pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --macro Ping --source +management --enable 1 --comment "ICMP from admin networks"
    fi
    pvesh get /cluster/firewall/rules --output-format json | grep -q "\"action\":\"pve-hosts\"" || pvesh create /cluster/firewall/rules --type group --action pve-hosts --enable 1
  '
  if is_true "$(q firewall.overlay_ping true)" && is_true "$(q sdn.evpn.enabled false)"; then
    script+='
    pvesh get /cluster/firewall/aliases --output-format json | grep -q "\"name\":\"sdn-overlay\"" || pvesh create /cluster/firewall/aliases --name sdn-overlay --cidr '"$(q 'sdn.evpn.vnets[0].cidr' | sed -E 's#^([0-9]+\.[0-9]+)\..*#\1.0.0/16#')"' --comment "EVPN vnet subnets"
    pvesh get /cluster/firewall/groups/pve-hosts --output-format json | grep -q "sdn-overlay" || pvesh create /cluster/firewall/groups/pve-hosts --type in --action ACCEPT --macro Ping --source sdn-overlay --enable 1 --comment "ICMP to anycast gateways"
    '
  fi
  script+='pvesh set /cluster/firewall/options --policy_in DROP --policy_out ACCEPT --ebtables 1'
  on "$f" "$script"
  on "$f" "pve-firewall compile >/dev/null"

  if peek "$f" 'pvesh get /cluster/firewall/options --output-format json | grep -q "\"enable\":1"'; then
    info "firewall already enabled"; return 0
  fi
  info "arming dead-man (auto-disable in 180s) and enabling"
  on "$f" "systemd-run --unit pvecb-fw-deadman --on-active=180 /usr/bin/pvesh set /cluster/firewall/options --enable 0 >/dev/null; pvesh set /cluster/firewall/options --enable 1"
  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0
  sleep 20
  for n in $(nodes); do
    peek "$n" 'pve-firewall status | grep -q enabled/running' || die "$n: firewall not running — dead-man will revert"
    ok "$n: SSH still reachable with firewall enabled"
  done
  on "$f" "systemctl stop pvecb-fw-deadman.timer"
  ok "dead-man disarmed; firewall enabled"
}
