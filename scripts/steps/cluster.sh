# summary: create cluster on founder, join others one at a time, SSH fallback keys
# shellcheck shell=bash
#
# Lessons baked in:
#  * Join nodes strictly one at a time and wait for pmxcfs to be writable on every
#    member before the next join. Interrupting a join mid-way (or packet loss during
#    the sync) wedges pmxcfs cluster-wide ("ignore sync request from wrong member").
#  * root's authorized_keys is a symlink into /etc/pve. If pmxcfs is down, SSH by key
#    fails. We mirror the keys into /root/.ssh/authorized_keys2 (read by default sshd).

_link_args() { # <node> -> --link0 address=..,priority=.. --link1 ...
  local n="$1" i=0 prio=20 l ip out=""
  for l in $(q 'corosync.links[*]'); do
    case "$l" in
      backend) ip="$(node_field "$n" backend_ip)" ;;
      mgmt)    ip="$(node_field "$n" mgmt_ip)" ;;
      *)       ip="$(node_field "$n" "${l}_ip")" ;;
    esac
    out+=" --link$i address=$ip,priority=$prio"; i=$((i+1)); prio=$((prio-10))
  done
  echo "$out"
}

_cluster_state() { [[ -f /etc/pve/corosync.conf ]] && awk '/cluster_name/{print $2}' /etc/pve/corosync.conf || echo none; }

_wait_all_pmxcfs() {
  local n
  for n in "$@"; do
    local t=0
    until pmxcfs_ok "$n" 2>/dev/null; do
      t=$((t+1)); ((t < 40)) || die "pmxcfs on $n not writable after ~2min — see recipes/troubleshooting/pmxcfs-wedged.md"
      sleep 3
    done
  done
}

step_cluster() {
  local name founder members=() n
  name="$(q cluster.name)"; founder="$(founder)"

  # --- create
  local st; st="$(peek_fn "$founder" _cluster_state)"
  if [[ "$st" == "none" ]]; then
    info "creating cluster '$name' on $founder"
    # shellcheck disable=SC2046
    on "$founder" "pvecm create $name $(_link_args "$founder")"
  elif [[ "$st" != "$name" ]]; then
    die "$founder already belongs to cluster '$st' (inventory says '$name')"
  else
    info "$founder already founded '$name'"
  fi
  [[ "$PVECB_DRY_RUN" == "1" ]] || _wait_all_pmxcfs "$founder"
  members+=("$founder")

  # --- join, one at a time
  local founder_ip; founder_ip="$(node_field "$founder" mgmt_ip)"
  for n in $(nodes); do
    [[ "$n" == "$founder" ]] && continue
    st="$(peek_fn "$n" _cluster_state)"
    if [[ "$st" == "$name" ]]; then info "$n already a member"; members+=("$n"); continue; fi
    [[ "$st" == "none" ]] || die "$n belongs to another cluster '$st'"
    local g; g="$(peek "$n" "echo \$(( \$(qm list 2>/dev/null | tail -n +2 | wc -l) + \$(pct list 2>/dev/null | tail -n +2 | wc -l) ))")"
    [[ "$g" == "0" ]] || die "$n has $g guests; a joining node must be empty (move or back them up first)"

    info "joining $n → $founder"
    # trust: joining node's root key into the cluster-wide authorized_keys
    local key; key="$(peek "$n" 'test -f /root/.ssh/id_ed25519.pub || ssh-keygen -q -t ed25519 -N "" -f /root/.ssh/id_ed25519; cat /root/.ssh/id_ed25519.pub')"
    on "$founder" "grep -qF '$key' /etc/pve/priv/authorized_keys || echo '$key' >> /etc/pve/priv/authorized_keys"
    on "$n" "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new root@$founder_ip true"
    # shellcheck disable=SC2046
    on "$n" "timeout 900 pvecm add $founder_ip --use_ssh $(_link_args "$n")" || warn "pvecm add returned non-zero; verifying state"
    members+=("$n")
    [[ "$PVECB_DRY_RUN" == "1" ]] || _wait_all_pmxcfs "${members[@]}"
    on "$n" "test -f /etc/pve/local/pve-ssl.pem || pvecm updatecerts --force; systemctl reload-or-restart pveproxy"
    ok "$n joined"
  done

  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0

  # --- verify quorum + links
  local want; want="$(nodes | wc -l | tr -d ' ')"
  peek "$founder" "corosync-quorumtool -s | grep -q 'Total votes: *$want'" || die "expected $want votes"
  peek "$founder" "corosync-quorumtool -s | grep -q 'Quorate: *Yes'" || die "cluster not quorate"
  ok "quorate with $want votes"
  peek "$founder" "corosync-cfgtool -n" | sed 's/^/    /'

  # --- SSH key fallback that does not depend on pmxcfs
  local keys; keys="$(peek "$founder" 'base64 -w0 /etc/pve/priv/authorized_keys')"
  for n in $(nodes); do
    on "$n" "echo '$keys' | base64 -d > /root/.ssh/authorized_keys2 && chmod 600 /root/.ssh/authorized_keys2"
  done
  ok "authorized_keys2 fallback installed on all nodes"
}
