# summary: EVPN controller + zone, vnets with SNAT subnets, apply, verify BGP
# shellcheck shell=bash

step_sdn() {
  is_true "$(q sdn.evpn.enabled false)" || { info "evpn disabled"; return 0; }
  local f n peers="" exits; f="$(founder)"
  for n in $(nodes); do peers+="$(node_field "$n" backend_ip),"; done; peers="${peers%,}"
  exits="$(q sdn.evpn.exit_nodes all)"; [[ "$exits" == "all" ]] && exits="$(nodes | paste -sd, -)"

  for n in $(nodes); do on "$n" "systemctl enable -q --now frr"; done

  local asn vx mtu; asn="$(q sdn.evpn.asn 65000)"; vx="$(q sdn.evpn.vrf_vxlan 10000)"; mtu="$(q sdn.evpn.mtu 1450)"
  local script
  script="
    have() { pvesh get \"\$1\" --output-format json 2>/dev/null | grep -q \"\\\"\$2\\\":\\\"\$3\\\"\"; }
    have /cluster/sdn/controllers controller evpn || pvesh create /cluster/sdn/controllers --controller evpn --type evpn --asn $asn --peers $peers
    have /cluster/sdn/zones zone evpn || pvesh create /cluster/sdn/zones --zone evpn --type evpn --controller evpn --vrf-vxlan $vx --exitnodes $exits --mtu $mtu --ipam pve --advertise-subnets 1
  "
  local i=0 v
  while v="$(q "sdn.evpn.vnets[$i]" '')"; [[ -n "$v" ]]; do
    local name tag cidr gw alias
    name="$(q "sdn.evpn.vnets[$i].name")"; tag="$(q "sdn.evpn.vnets[$i].tag")"; cidr="$(q "sdn.evpn.vnets[$i].cidr")"
    gw="$(q "sdn.evpn.vnets[$i].gateway")"; alias="$(q "sdn.evpn.vnets[$i].alias" "$name")"
    script+="
    have /cluster/sdn/vnets vnet $name || pvesh create /cluster/sdn/vnets --vnet $name --zone evpn --tag $tag --alias '$alias'
    pvesh get /cluster/sdn/vnets/$name/subnets --output-format json | grep -q '\"cidr\":\"$cidr\"' || pvesh create /cluster/sdn/vnets/$name/subnets --type subnet --subnet $cidr --gateway $gw --snat 1
    "
    i=$((i+1))
  done
  script+="pvesh set /cluster/sdn >/dev/null"
  on "$f" "$script"

  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0
  local want=$(( $(nodes | wc -l) - 1 )) t=0
  local count_py='import json,sys; d=json.load(sys.stdin); print(sum(1 for p in d.get("peers",{}).values() if p.get("state")=="Established"))'
  until [[ "$(peek "$f" "vtysh -c 'show bgp l2vpn evpn summary json' | python3 -c '$count_py'" 2>/dev/null || echo 0)" -ge "$want" ]]; do
    t=$((t+1)); ((t < 40)) || { peek "$f" "vtysh -c 'show bgp summary'"; die "EVPN BGP sessions not established"; }
    sleep 3
  done
  ok "EVPN BGP established with $want peers"
}
