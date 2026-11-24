# summary: health checks on every node + end-to-end smoke test (guests 99901/99902, auto-cleaned)
# shellcheck shell=bash

_smoke_cleanup() {
  local f="$1" n
  peek "$f" 'ha-manager remove ct:99902 2>/dev/null || true' >/dev/null
  for n in $(nodes); do
    peek "$n" 'for id in 99901 99902; do pct status $id >/dev/null 2>&1 && { pct stop $id 2>/dev/null; pct destroy $id --purge 1 >/dev/null; }; done; rm -f /'"$(q storage.local_zfs.pool nvme-local)"'/backup/dump/vzdump-lxc-9990[12]-* 2>/dev/null; true' >/dev/null || true
  done
}

step_validate() {
  local f n worst=0; f="$(founder)"
  local hs; hs="$(cat "$PVECB_ROOT/scripts/pve-health.sh")"
  for n in $(nodes); do
    info "--- health: $n"
    local flag="--node-only"; [[ "$n" == "$f" ]] && flag=""
    local rc=0
    peek "$n" "cat > /tmp/pve-health.sh <<'HS'
$hs
HS
bash /tmp/pve-health.sh $flag" | sed 's/^/    /' || rc=$?
    (( rc > worst )) && worst=$rc
  done
  ((worst < 2)) || die "critical health findings — fix before using the cluster"

  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0
  is_true "$(q sdn.evpn.enabled false)" || { info "SDN disabled: skipping overlay smoke test"; return 0; }
  local vnet cidr gw pool tmpl
  vnet="$(q 'sdn.evpn.vnets[0].name')"; cidr="$(q 'sdn.evpn.vnets[0].cidr')"; gw="$(q 'sdn.evpn.vnets[0].gateway')"
  pool="$(q storage.ceph.pool vm-pool)"
  local base="${cidr%.*}" pfx="${cidr#*/}"
  local n1 n2; n1="$(nodes | sed -n 2p)"; n2="$(nodes | sed -n 3p)"; [[ -n "$n1" ]] || n1="$f"; [[ -n "$n2" ]] || n2="$f"

  step "smoke test: CT 99901@$n1 and 99902@$n2 on vnet '$vnet' ($pool)"
  # EXIT as well as RETURN: die() exits, which does not fire RETURN traps
  trap '_smoke_cleanup "$f"' RETURN
  trap '_smoke_cleanup "$f"; rm -f "$INV_JSON"' EXIT
  tmpl="$(peek "$f" 'pveam update >/dev/null 2>&1; st=$(pvesm status -content vztmpl | awk "NR>1&&\$3==\"active\"{print \$1}" | grep -m1 cephfs || pvesm status -content vztmpl | awk "NR>1&&\$3==\"active\"{print \$1; exit}"); t=$(pveam available --section system | awk "/debian-13-standard.*amd64/{print \$2}" | tail -1); pveam list $st | grep -q "$t" || pveam download $st $t >/dev/null; echo "$st:vztmpl/$t"')"
  info "template $tmpl"
  local i=1 node
  for node in "$n1" "$n2"; do
    local id=$((99900 + i))
    on "$node" "pct create $id $tmpl --hostname pvecb-smoke-$i --storage $pool --rootfs $pool:2 --memory 256 --cores 1 \
      --net0 name=eth0,bridge=$vnet,ip=$base.$((240 + i))/$pfx,gw=$gw --nameserver 1.1.1.1 --unprivileged 1 --features nesting=1 --start 1 >/dev/null"
    i=$((i+1))
  done
  sleep 5
  peek "$n1" "pct exec 99901 -- ping -c3 -W2 -q $base.242" >/dev/null && ok "cross-node overlay ($n1 → $n2)" || die "overlay ping failed"
  peek "$n1" "pct exec 99901 -- ping -c2 -W2 -q $gw" >/dev/null && ok "anycast gateway $gw" || warn "gateway ping blocked (firewall.overlay_ping?)"
  peek "$n1" "pct exec 99901 -- ping -c3 -W2 -q 1.1.1.1" >/dev/null && ok "internet via SNAT exit" || die "SNAT egress failed"
  peek "$n1" "pct exec 99901 -- ping -c2 -W2 -q -M do -s $(( $(q sdn.evpn.mtu 1450) - 28 )) $base.242" >/dev/null && ok "full vnet MTU path" || warn "vnet MTU path smaller than $(q sdn.evpn.mtu 1450)"

  on "$f" "ha-manager add ct:99902 --state started >/dev/null"
  # HA must own the resource (state 'started' in the manager) before a relocate request
  # is accepted; a relocate sent earlier is silently dropped.
  wait_for "$f" 120 "ha-manager status | grep -q 'ct:99902 ($n2, started)'" || die "HA did not take ownership of ct:99902"
  local t0=$SECONDS
  on "$f" "ha-manager crm-command relocate ct:99902 $f"
  wait_for "$f" 180 "ha-manager status | grep -q 'ct:99902 ($f, started)'" && ok "HA relocate $n2 → $f in $((SECONDS - t0))s" || die "HA relocation failed"
  if [[ -n "$(q backups.storage '')" ]]; then
    on "$n1" "vzdump 99901 --storage $(q backups.storage) --mode snapshot --compress zstd >/dev/null 2>&1" && ok "snapshot backup to $(q backups.storage)" || die "backup failed"
  fi
  ok "smoke test passed (cleaning up)"
}
