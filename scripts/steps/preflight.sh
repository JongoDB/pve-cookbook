# summary: read-only checks: reachability, versions, disks, NICs, time, repos
# shellcheck shell=bash

_preflight_node() {
  local expect_name="$1" mgmt_ip="$2" osd_match="$3" zfs_match="$4" uplink="$5"
  echo "pve=$(pveversion | cut -d/ -f2) kernel=$(uname -r)"
  echo "hostname=$(hostname -s)"
  [[ "$(hostname -s)" == "$expect_name" ]] || echo "WARN hostname is $(hostname -s), inventory says $expect_name"
  ip -br a | grep -q "$mgmt_ip/" || echo "FAIL mgmt_ip $mgmt_ip not configured on any interface"
  if [[ -f /etc/pve/corosync.conf ]]; then echo "cluster=$(awk '/cluster_name/{print $2}' /etc/pve/corosync.conf)"; else echo "cluster=none"; fi
  echo "guests=$(( $(qm list 2>/dev/null | tail -n +2 | wc -l) + $(pct list 2>/dev/null | tail -n +2 | wc -l) ))"
  local boot; boot="$(lsblk -no PKNAME "$(findmnt -no SOURCE /boot/efi 2>/dev/null || findmnt -no SOURCE /)" 2>/dev/null | head -1)"
  echo "bootdisk=${boot:-unknown}"
  while read -r name size model; do
    local tag=""
    [[ -n "$osd_match" && "$model" == *"$osd_match"* ]] && tag="ceph-osd"
    [[ -n "$zfs_match" && "$model" == *"$zfs_match"* ]] && tag="local-zfs"
    [[ "$name" == "$boot" ]] && tag="BOOT"
    local fs; fs="$(lsblk -no FSTYPE "/dev/$name" | sort -u | grep -v '^$' | tr '\n' ',' )"
    echo "disk $name $size [$model] role=${tag:-unused} existing=${fs:-none}"
  done < <(lsblk -dno NAME,SIZE,MODEL | grep -v '^zd\|^loop\|^sr' | awk '{n=$1; s=$2; $1=$2=""; sub(/^  /,""); print n, s, $0}')
  local pn; pn="$(ethtool -m "$uplink" 2>/dev/null | awk -F: '/Vendor PN/{gsub(/ /,"",$2); print $2}')"
  local fc; fc="$(ethtool -a "$uplink" 2>/dev/null | awk '/^RX:/{r=$2} /^TX:/{t=$2} END{print r"/"t}')"
  echo "uplink=$uplink speed=$(cat /sys/class/net/"$uplink"/speed 2>/dev/null)Mb module=${pn:-n/a} flowcontrol=$fc"
  if [[ ( "$pn" == *10G-T* || "$pn" == *10GT* ) && "$fc" != "on/on" ]]; then
    echo "WARN $uplink uses a rate-adapting 10GBASE-T SFP ($pn). If the switch port is 1G/2.5G, set network.flow_control: true"
  fi
  echo "timesync=$(timedatectl show -p NTPSynchronized --value)"
  local aerr; aerr="$(apt-get update 2>&1 | grep -cE '^(E|Err):' || true)"
  echo "apt_errors=$aerr"
  echo "mem_gib=$(free -g | awk '/Mem:/{print $2}') cpus=$(nproc)"
}

step_preflight() {
  local n fails=0
  for n in $(nodes); do
    info "--- $n ($(node_field "$n" ssh))"
    local out
    if ! out="$(peek_fn "$n" _preflight_node "$n" "$(node_field "$n" mgmt_ip)" \
          "$(q storage.ceph.osd_model_match '')" "$(q storage.local_zfs.model_match '')" \
          "$(q network.mgmt.uplink nic0)" 2>&1)"; then
      warn "$n: unreachable over SSH"; fails=$((fails+1)); continue
    fi
    while IFS= read -r l; do
      case "$l" in
        FAIL*) warn "$n: ${l#FAIL }"; fails=$((fails+1)) ;;
        WARN*) warn "$n: ${l#WARN }" ;;
        *) info "$l" ;;
      esac
    done <<<"$out"
    grep -q '^apt_errors=0' <<<"$out" || warn "$n: apt has errors (enterprise repo without subscription?) — base-os fixes this"
    grep -q '^timesync=yes' <<<"$out" || warn "$n: clock not NTP-synchronized (Ceph requires it)"
  done
  ((fails == 0)) || die "preflight found $fails blocking problem(s)"
}
