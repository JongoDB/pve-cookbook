# summary: Ceph install, mons/mgrs, tuning, OSDs, NVMe CRUSH rule, RBD pool, CephFS
# shellcheck shell=bash

_ceph_osd_candidates() { # <model-match> [explicit devices...] -> /dev paths that are safe to use
  local match="$1"; shift
  local boot; boot="$(lsblk -no PKNAME "$(findmnt -no SOURCE /boot/efi 2>/dev/null || findmnt -no SOURCE /)" | head -1)"
  local devs=()
  if (($#)); then devs=("$@")
  else while read -r name model; do [[ "$model" == *"$match"* ]] && devs+=("/dev/$name"); done < <(lsblk -dno NAME,MODEL); fi
  for d in "${devs[@]}"; do
    local real; real="$(readlink -f "$d")"
    [[ "$(basename "$real")" == "$boot" ]] && { echo "REFUSE-BOOT $d" >&2; continue; }
    if lsblk -no FSTYPE "$real" | grep -q ceph_bluestore; then echo "HAS-OSD $real"; else echo "FREE $real"; fi
  done
}

_ceph_wipe() { # <dev> — remove old ZFS/LVM/VMFS/partition signatures
  local d="$1"
  for vg in $(pvs --noheadings -o vg_name "$d"* 2>/dev/null | sort -u); do vgchange -an "$vg" >/dev/null 2>&1 || true; done
  wipefs -af "$d"* >/dev/null 2>&1 || true
  sgdisk --zap-all "$d" >/dev/null
  blkdiscard -f "$d" 2>/dev/null || dd if=/dev/zero of="$d" bs=1M count=200 status=none
}

step_ceph() {
  is_true "$(q storage.ceph.enabled false)" || { info "ceph disabled in inventory"; return 0; }
  local founder n cidr; founder="$(founder)"; cidr="$(q network.backend.cidr)"

  # install
  for n in $(nodes); do
    if peek "$n" 'command -v ceph-osd >/dev/null'; then info "$n: ceph already installed"
    else info "$n: installing ceph squid"; on "$n" "yes | pveceph install --repository $( [[ $(q cluster.repos) == enterprise ]] && echo enterprise || echo no-subscription) --version squid >/tmp/pveceph-install.log 2>&1"; fi
  done

  # init + mons + mgrs
  peek "$founder" 'test -f /etc/pve/ceph.conf' || on "$founder" "pveceph init --network $cidr --cluster-network $cidr"
  for n in $(nodes); do
    peek "$n" "test -d /var/lib/ceph/mon/ceph-$n" || on "$n" "pveceph mon create"
    peek "$n" "test -d /var/lib/ceph/mgr/ceph-$n" || on "$n" "pveceph mgr create"
  done

  # tuning (idempotent)
  local mt; mt=$(( $(q storage.ceph.osd_memory_target_gib 4) * 1024 * 1024 * 1024 ))
  on "$founder" "
    ceph config set osd osd_memory_target $mt
    ceph config set global mon_osd_down_out_interval 600
    ceph config set mgr mgr/balancer/mode upmap; ceph balancer on
    ceph config set osd osd_scrub_begin_hour 0; ceph config set osd osd_scrub_end_hour 6
    $(is_true "$(q storage.ceph.protect_client_io true)" && echo 'ceph config set osd osd_mclock_profile high_client_ops; ceph config set osd osd_max_backfills 1; ceph config set osd osd_recovery_max_active 1')"

  # OSDs
  local cls match; cls="$(q storage.ceph.device_class nvme)"; match="$(q storage.ceph.osd_model_match '')"
  for n in $(nodes); do
    local explicit=() d   # bash 3.2 compatible (macOS): no mapfile
    while IFS= read -r d; do [[ -n "$d" ]] && explicit+=("$d"); done < <(q "nodes[name=$n].osd_devices[*]" '')
    while read -r state dev; do
      [[ -z "$state" ]] && continue
      if [[ "$state" == "HAS-OSD" ]]; then info "$n: $dev already an OSD"; continue; fi
      if peek "$n" "lsblk -no FSTYPE $dev | grep -q ." ; then
        is_true "$(q storage.wipe_confirm false)" || die "$n:$dev has existing data; set storage.wipe_confirm: true to allow wiping"
        confirm "WIPE $n:$dev ($(peek "$n" "lsblk -dno MODEL,SIZE $dev"))"
        on_fn "$n" _ceph_wipe "$dev"
      fi
      on "$n" "pveceph osd create $dev --crush-device-class $cls" | tail -1 | sed 's/^/    /'
    done < <(peek_fn "$n" _ceph_osd_candidates "$match" ${explicit[@]+"${explicit[@]}"})
  done

  # pools
  local pool size min; pool="$(q storage.ceph.pool vm-pool)"; size="$(q storage.ceph.size 3)"; min="$(q storage.ceph.min_size 2)"
  on "$founder" "
    ceph osd crush rule ls | grep -qx replicated-$cls || ceph osd crush rule create-replicated replicated-$cls default host $cls
    if ! ceph osd pool ls | grep -qx $pool; then
      pveceph pool create $pool --size $size --min_size $min --application rbd --crush_rule replicated-$cls --pg_autoscale_mode on --target_size_ratio 0.9 --add_storages 1
      ceph osd pool set $pool bulk true
    fi"
  if is_true "$(q storage.ceph.cephfs true)"; then
    for n in $(nodes); do peek "$n" "test -d /var/lib/ceph/mds/ceph-$n" || on "$n" "pveceph mds create"; done
    on "$founder" "
      if ! ceph fs ls | grep -q 'name: cephfs'; then
        pveceph fs create --name cephfs --pg_num 32 --add-storage 1
        ceph osd pool set cephfs_data crush_rule replicated-$cls; ceph osd pool set cephfs_metadata crush_rule replicated-$cls
        ceph osd pool set cephfs_metadata target_size_ratio 0.01; ceph osd pool set cephfs_data target_size_ratio 0.05
        ceph fs set cephfs allow_standby_replay true
      fi
      pvesm set cephfs --content iso,vztmpl,snippets,import"
  fi

  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0
  local t=0
  until peek "$founder" 'ceph health | grep -q HEALTH_OK'; do
    t=$((t+1)); ((t < 60)) || { peek "$founder" 'ceph health detail' | sed 's/^/    /'; die "ceph not HEALTH_OK after 3 min"; }
    sleep 3
  done
  peek "$founder" 'ceph -s | grep -E "health|mon:|mgr:|mds:|osd:|usage"' | sed 's/^/    /'
}
