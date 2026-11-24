# summary: per-node ZFS pool on a fast local disk -> local-zfs + backup-local storages
# shellcheck shell=bash

_zfs_node() {
  local pool="$1" match="$2" quota="$3" dev="$4"
  if zpool list -H "$pool" >/dev/null 2>&1; then
    # repair older layouts where vmdata had no mountpoint (breaks LXC on local-zfs)
    [[ "$(zfs get -H -o value mountpoint "$pool/vmdata" 2>/dev/null)" == none ]] && zfs set mountpoint="/$pool/vmdata" "$pool/vmdata"
    echo "EXISTS"; return 0
  fi
  if [[ -z "$dev" ]]; then
    local name; name="$(lsblk -dno NAME,MODEL | awk -v m="$match" 'index($0,m){print $1; exit}')"
    [[ -n "$name" ]] || { echo "FAIL no disk matching '$match'"; return 1; }
    dev="/dev/disk/by-id/$(find /dev/disk/by-id -lname "*/$name" -name 'nvme-*' ! -name '*_1' ! -name '*-part*' -printf '%f\n' | head -1)"
    [[ "$dev" != "/dev/disk/by-id/" ]] || dev="/dev/$name"
  fi
  echo "DEV $dev"
}

_zfs_create() {
  local pool="$1" dev="$2" quota="$3"
  for vg in $(pvs --noheadings -o vg_name "$dev"* 2>/dev/null | sort -u); do vgchange -an "$vg" >/dev/null 2>&1 || true; done
  wipefs -af "$dev"* >/dev/null 2>&1 || true; sgdisk --zap-all "$dev" >/dev/null
  zpool create -f -o ashift=12 -o autotrim=on -O compression=zstd -O atime=off -O xattr=sa \
    -O acltype=posixacl -O dnodesize=auto -m none "$pool" "$dev"
  # containers need a mountpoint on the dataset (subvols inherit it); zvols do not care
  zfs create -o recordsize=16k -o mountpoint="/$pool/vmdata" "$pool/vmdata"
  zfs create -o mountpoint="/$pool/backup" -o recordsize=1M -o quota="$quota" "$pool/backup"
  echo "created $pool on $dev"
}

step_local_zfs() {
  is_true "$(q storage.local_zfs.enabled false)" || { info "local_zfs disabled"; return 0; }
  local pool match quota n; pool="$(q storage.local_zfs.pool nvme-local)"; match="$(q storage.local_zfs.model_match)"; quota="$(q storage.local_zfs.backup_quota 500G)"
  for n in $(nodes); do
    local out; out="$(peek_fn "$n" _zfs_node "$pool" "$match" "$quota" "$(node_field "$n" zfs_device '')")"
    case "$out" in
      EXISTS) info "$n: pool $pool exists" ;;
      FAIL*)  die "$n: ${out#FAIL }" ;;
      DEV*)   local dev="${out#DEV }"
              if peek "$n" "lsblk -no FSTYPE \$(readlink -f $dev) | grep -q ."; then
                is_true "$(q storage.wipe_confirm false)" || die "$n:$dev has data; set storage.wipe_confirm: true"
                confirm "WIPE $n:$dev for ZFS pool $pool"
              fi
              on_fn "$n" _zfs_create "$pool" "$dev" "$quota" | sed 's/^/    /' ;;
    esac
  done
  local f; f="$(founder)"
  on "$f" "
    pvesm status | grep -q '^local-zfs ' || pvesm add zfspool local-zfs --pool $pool/vmdata --content images,rootdir --sparse 1 --blocksize 16k
    pvesm status | grep -q '^backup-local ' || pvesm add dir backup-local --path /$pool/backup --content backup --is_mountpoint yes --prune-backups '$(q backups.retention keep-last=3,keep-daily=7)'
    pvesm set local --content iso,vztmpl,import
    pvesm status | grep -q '^local-lvm ' && pvesm set local-lvm --disable 1 || true"
  [[ "$PVECB_DRY_RUN" == "1" ]] || peek "$f" 'pvesm status' | sed 's/^/    /'
}
