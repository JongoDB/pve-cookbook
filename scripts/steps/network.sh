# summary: backend network (shared-bridge | dedicated), uplink flow control
# shellcheck shell=bash

_network_node() {
  local mode="$1" bridge="$2" uplink="$3" backend_cidr_ip="$4" iface="$5" mtu="$6" fc="$7"
  local f=/etc/network/interfaces changed=0
  cp -n "$f" "$f.pre-pve-cookbook" 2>/dev/null || true

  # --- flow control on the uplink (pause frames). Persist via post-up on the NIC stanza.
  if [[ "$fc" == "true" ]]; then
    if ! grep -q "ethtool -A $uplink" "$f"; then
      grep -q "^iface $uplink inet manual" "$f" || { echo "FAIL no 'iface $uplink inet manual' stanza"; return 1; }
      sed -i "s|^iface $uplink inet manual|iface $uplink inet manual\n\tpost-up /usr/sbin/ethtool -A $uplink rx on tx on \|\| true|" "$f"
      changed=1; echo "flow control persisted on $uplink"
    fi
    ethtool -A "$uplink" rx on tx on 2>/dev/null || true
    echo "flowcontrol=$(ethtool -a "$uplink" | awk '/^RX:/{r=$2} /^TX:/{t=$2} END{print r"/"t}')"
  fi

  # --- backend addressing
  local ip="${backend_cidr_ip%/*}"
  case "$mode" in
    shared-bridge)
      if ! grep -q "ip addr add $backend_cidr_ip dev $bridge" "$f"; then
        # Inject after the bridge-fd line of the bridge stanza (PVE GUI preserves post-up/pre-down).
        sed -i "/^iface $bridge inet static/,/^$/ s|^\tbridge-fd 0$|\tbridge-fd 0\n\tpost-up ip addr add $backend_cidr_ip dev $bridge \|\| true\n\tpre-down ip addr del $backend_cidr_ip dev $bridge \|\| true|" "$f"
        grep -q "ip addr add $backend_cidr_ip dev $bridge" "$f" || { echo "FAIL could not find 'bridge-fd 0' in $bridge stanza"; return 1; }
        changed=1; echo "backend $backend_cidr_ip added to $bridge (shared-bridge)"
      fi
      ip -br a show "$bridge" | grep -q "$ip/" || ip addr add "$backend_cidr_ip" dev "$bridge"
      ;;
    dedicated)
      [[ -n "$iface" ]] || { echo "FAIL network.backend.iface required for mode=dedicated"; return 1; }
      if ! grep -q "^iface $iface inet static" "$f"; then
        sed -i "/^iface $iface inet manual/d" "$f"
        printf '\nauto %s\niface %s inet static\n\taddress %s\n\tmtu %s\n#\tpve-cookbook backend\n' "$iface" "$iface" "$backend_cidr_ip" "$mtu" >>"$f"
        changed=1; echo "backend $backend_cidr_ip on $iface (dedicated)"
      fi
      ;;
    mesh)
      echo "FAIL mode=mesh is configured via SDN fabrics — follow recipes/topologies/full-mesh.md"; return 1 ;;
    *) echo "FAIL unknown backend mode '$mode'"; return 1 ;;
  esac

  if ((changed)); then
    ifreload -a 2>&1 | grep -v "bridge-fd: value of out range" || true
  fi
  ip -br a | grep -q "$ip/" || { echo "FAIL backend IP $ip not up"; return 1; }
  echo "backend=$ip up"
}

step_network() {
  local n cidr prefix
  cidr="$(q network.backend.cidr)"; prefix="${cidr#*/}"
  for n in $(nodes); do
    info "--- $n"
    on_fn "$n" _network_node "$(q network.backend.mode shared-bridge)" "$(q network.mgmt.bridge vmbr0)" \
      "$(q network.mgmt.uplink nic0)" "$(node_field "$n" backend_ip)/$prefix" \
      "$(q network.backend.iface '')" "$(q network.backend.mtu 1500)" "$(q network.flow_control false)" \
      | sed 's/^/    /'
  done
  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0
  step "backend reachability (all pairs)"
  local a b
  for a in $(nodes); do for b in $(nodes); do
    [[ "$a" == "$b" ]] && continue
    peek "$a" "ping -c2 -W1 -q $(node_field "$b" backend_ip) >/dev/null" || die "$a cannot reach $b on backend"
  done; done
  ok "backend full reachability"
}
