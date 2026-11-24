#!/usr/bin/env bash
# pve-health.sh — read-only health & drift checks for a Proxmox VE node/cluster.
# Run on any PVE node. No inventory needed.
#
#   pve-health.sh            human output
#   pve-health.sh --json     one JSON object per line (consumed by galley/agents)
#   pve-health.sh --node-only  skip cluster-wide checks (use when looping over nodes)
#
# Exit code: 0 all OK, 1 warnings, 2 critical.
set -uo pipefail

JSON=0 NODE_ONLY=0
for a in "$@"; do case "$a" in --json) JSON=1 ;; --node-only) NODE_ONLY=1 ;; -h|--help) sed -n '2,10p' "$0"; exit 0 ;; esac; done
NODE="$(hostname -s)"; WORST=0

emit() { # <OK|WARN|CRIT|INFO> <check-id> <message>
  local lvl="$1" id="$2" msg="$3"
  case "$lvl" in WARN) ((WORST<1)) && WORST=1 ;; CRIT) WORST=2 ;; esac
  if ((JSON)); then
    python3 -c 'import json,sys; print(json.dumps({"node":sys.argv[1],"level":sys.argv[2],"check":sys.argv[3],"message":sys.argv[4]}))' "$NODE" "$lvl" "$id" "$msg"
  else
    local c; case "$lvl" in OK) c=$'\e[32m' ;; WARN) c=$'\e[33m' ;; CRIT) c=$'\e[31m' ;; *) c=$'\e[2m' ;; esac
    [[ -t 1 ]] || c=""; printf '%s%-4s%s %-22s %s\n' "$c" "$lvl" "${c:+$'\e[0m'}" "$id" "$msg"
  fi
}

# Run a probe that might block on a wedged pmxcfs without hanging this script.
bounded() { local t="$1"; shift; ( "$@" ) & local p=$!; for _ in $(seq $((t*4))); do kill -0 $p 2>/dev/null || { wait $p; return $?; }; sleep 0.25; done; return 124; }

# ---------------- node checks ----------------
check_pmxcfs() {
  if bounded 5 bash -c 'touch /etc/pve/.health-wt && rm -f /etc/pve/.health-wt'; then emit OK pmxcfs "/etc/pve writable"
  else emit CRIT pmxcfs "/etc/pve not writable within 5s (no quorum or wedged sync) — recipes/troubleshooting/pmxcfs-wedged.md"; fi
}

check_time() {
  if [[ "$(timedatectl show -p NTPSynchronized --value)" == yes ]]; then emit OK time "NTP synchronized"; else emit CRIT time "clock not NTP-synchronized (breaks Ceph/corosync)"; fi
}

check_repos() {
  local ent; ent="$(grep -lE '^[^#]*enterprise\.proxmox\.com' /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list 2>/dev/null | grep -v disabled || true)"
  local sub; sub="$(pvesubscription get 2>/dev/null | awk '/^status:/{print $2}')"
  if [[ -n "$ent" && "$sub" != "active" ]]; then emit WARN repos "enterprise repo enabled without active subscription: $ent"
  else emit OK repos "repositories consistent with subscription (${sub:-none})"; fi
}

check_updates() {
  local n; n="$(apt list --upgradable 2>/dev/null | grep -c upgradable || true)"
  if ((n == 0)); then emit OK updates "no pending package updates (cache age: $(( ($(date +%s) - $(stat -c %Y /var/lib/apt/lists 2>/dev/null || date +%s)) / 3600 ))h)"; else emit WARN updates "$n packages upgradable"; fi
  local newest; newest="$(find /boot -maxdepth 1 -name 'vmlinuz-*' -printf '%f\n' | sed 's/vmlinuz-//' | sort -V | tail -1)"
  if [[ "$newest" == "$(uname -r)" ]]; then emit OK kernel "running newest kernel $(uname -r)"; else emit WARN kernel "reboot pending: running $(uname -r), installed $newest"; fi
}

check_uplink_fc() {
  local dev pn fc
  for dev in /sys/class/net/*; do
    dev="${dev##*/}"
    [[ -e "/sys/class/net/$dev/device" && "$(cat "/sys/class/net/$dev/operstate")" == up ]] || continue
    pn="$(ethtool -m "$dev" 2>/dev/null | awk -F: '/Vendor PN/{gsub(/ /,"",$2); print $2}')"
    [[ "$pn" == *10G-T* || "$pn" == *10GT* ]] || continue
    fc="$(ethtool -a "$dev" 2>/dev/null | awk '/^RX:/{r=$2} /^TX:/{t=$2} END{print r"/"t}')"
    if [[ "$fc" == on/on ]]; then emit OK flowcontrol "$dev ($pn) pause frames on"; else
      emit WARN flowcontrol "$dev uses rate-adapting $pn with flow control $fc — bursts will drop on 1G ports (recipes/troubleshooting/sfp-10g-t-flow-control.md)"; fi
  done
}

check_corosync() {
  [[ -f /etc/pve/corosync.conf ]] || { emit INFO corosync "standalone node (no cluster)"; return; }
  local links; links="$(corosync-cfgtool -n 2>/dev/null | grep -c 'enabled connected' || true)"
  local peers; peers="$(corosync-cfgtool -n 2>/dev/null | grep -c '^nodeid' || true)"
  if ((peers > 0)); then
    local per=$((links / peers))
    if ((per >= 2)); then emit OK corosync-links "$per connected links to each of $peers peers"; else emit WARN corosync-links "only $per corosync link per peer — add a redundant link"; fi
  fi
  # Bursts during heavy traffic on a shared link are survivable (WARN); a sustained storm
  # (many retransmits in the last 2 min) is how a wedged pmxcfs sync looks (CRIT).
  local rt10 rt2
  rt10="$(journalctl -u corosync --since -10min --no-pager 2>/dev/null | grep -c 'Retransmit List' || true)"
  rt2="$(journalctl -u corosync --since -2min --no-pager 2>/dev/null | grep -c 'Retransmit List' || true)"
  if ((rt2 >= 20)); then emit CRIT corosync-retx "$rt2 retransmits in last 2 min — sustained loss on cluster network (recipes/troubleshooting/pmxcfs-wedged.md)"
  elif ((rt10 >= 5)); then emit WARN corosync-retx "$rt10 retransmits in last 10 min — cluster link saturated or lossy; corosync needs a dedicated/redundant link"
  else emit OK corosync-retx "$rt10 retransmits in last 10 min"; fi
}

check_certs() {
  local f=/etc/pve/local/pve-ssl.pem
  [[ -f "$f" ]] || { emit WARN cert "no node certificate ($f) — pvecm updatecerts --force"; return; }
  openssl x509 -checkend $((30*86400)) -noout -in "$f" >/dev/null && emit OK cert "node cert valid > 30 days" || emit WARN cert "node cert expires within 30 days"
}

check_udev() {
  # A udevd left over from the initramfs (init.scope, deleted binary) announces device
  # events before rules run. `rbd map` then returns before /dev/rbd-pve symlinks exist
  # and every container create on Ceph RBD fails in mkfs. Seen after booting with a
  # stale/duplicate LVM volume group on a secondary disk.
  local stray="" p
  for p in $(pgrep -x systemd-udevd; pgrep -f 'systemd-udevd --daemon'); do
    grep -q 'init.scope' "/proc/$p/cgroup" 2>/dev/null && stray+="$p "
  done
  if [[ -n "$stray" ]]; then emit CRIT udev "stray initramfs udevd (pid ${stray% }) — breaks RBD mapping; kill it (recipes/troubleshooting/stray-initramfs-udevd.md)"
  else emit OK udev "single udevd (systemd-managed)"; fi
}

check_ssh_fallback() {
  if [[ -s /root/.ssh/authorized_keys2 ]]; then emit OK ssh-fallback "authorized_keys2 present (SSH survives pmxcfs outage)"; else
    emit WARN ssh-fallback "no /root/.ssh/authorized_keys2 — key SSH breaks when pmxcfs is down"; fi
}

check_disks() {
  local use; use="$(df --output=pcent / | tail -1 | tr -dc 0-9)"
  if ((use < 80)); then emit OK rootfs "root fs ${use}% used"; else emit WARN rootfs "root fs ${use}% used"; fi
  local p h
  while read -r p h; do [[ "$h" == ONLINE ]] && emit OK zfs "pool $p ONLINE" || emit CRIT zfs "pool $p $h"; done < <(zpool list -H -o name,health 2>/dev/null)
  local d w
  for d in /dev/nvme[0-9]n1; do
    [[ -e "$d" ]] || continue
    w="$(nvme smart-log "$d" 2>/dev/null | awk -F: '/percentage_used/{gsub(/[ %]/,"",$2); print $2}')"
    [[ -z "$w" ]] && continue
    if ((w < 80)); then emit OK nvme-wear "$(basename "$d") ${w}% endurance used"; else emit WARN nvme-wear "$(basename "$d") ${w}% endurance used"; fi
  done
}

# ---------------- cluster checks ----------------
check_quorum() {
  [[ -f /etc/pve/corosync.conf ]] || return
  local s; s="$(corosync-quorumtool -s 2>/dev/null)"
  local exp tot; exp="$(awk '/Expected votes/{print $3}' <<<"$s")"; tot="$(awk '/Total votes/{print $3}' <<<"$s")"
  if grep -q 'Quorate: *Yes' <<<"$s" && [[ "$exp" == "$tot" ]]; then emit OK quorum "quorate, $tot/$exp votes"
  else emit CRIT quorum "votes $tot/$exp $(grep -o 'Quorate:.*' <<<"$s")"; fi
}

check_ceph() {
  command -v ceph >/dev/null && [[ -f /etc/pve/ceph.conf ]] || return
  local h; h="$(bounded 10 ceph health 2>/dev/null)" || { emit CRIT ceph "ceph CLI timed out (mons unreachable?)"; return; }
  case "$h" in HEALTH_OK*) emit OK ceph "$h" ;; HEALTH_WARN*) emit WARN ceph "$h" ;; *) emit CRIT ceph "$h" ;; esac
  local st; st="$(ceph osd stat -f json 2>/dev/null)"
  python3 - "$st" <<'PY' | while IFS='|' read -r l m; do emit "$l" ceph-osd "$m"; done
import json,sys; d=json.loads(sys.argv[1]); n,u,i=d["num_osds"],d["num_up_osds"],d["num_in_osds"]
print(("OK" if n==u==i else "CRIT")+f"|{u}/{n} OSDs up, {i} in")
PY
  ceph osd dump -f json 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); f=d.get("flags","")
print(f)' | grep -qE 'noout|norebalance|nobackfill' && emit WARN ceph-flags "maintenance flags set: $(ceph osd dump | awk '/^flags/{print $2}')"
}

check_storage() {
  pvesh get /nodes/"$NODE"/storage --output-format json 2>/dev/null | python3 -c "$(cat <<'PY2'
import json, sys
for s in json.load(sys.stdin):
    name = s["storage"]
    if not s.get("active"):
        if s.get("enabled", 1): print(f"CRIT|{name} inactive")
        continue
    if not s.get("total"): continue
    p = 100 * s["used"] / s["total"]
    lvl = "OK" if p < 80 else "WARN" if p < 90 else "CRIT"
    print(f"{lvl}|{name} {p:.0f}% used")
PY2
)" | while IFS='|' read -r l m; do emit "$l" storage "$m"; done
}

check_ha() {
  [[ -f /etc/pve/corosync.conf ]] || return
  local s; s="$(bounded 10 ha-manager status 2>/dev/null)" || { emit WARN ha "ha-manager status timed out"; return; }
  if grep -q 'quorum OK' <<<"$s"; then emit OK ha "$(grep -c '^service' <<<"$s") HA resources, quorum OK"; else emit CRIT ha "HA quorum not OK"; fi
  grep -E '^service .*\((error|fence)' <<<"$s" | while read -r l; do emit CRIT ha-resource "$l"; done
}

check_firewall() {
  if pvesh get /cluster/firewall/options --output-format json 2>/dev/null | grep -q '"enable":1'; then
    emit OK firewall "datacenter firewall enabled"; else emit WARN firewall "datacenter firewall disabled"; fi
}

check_backups() {
  python3 - <<'PY' | while IFS='|' read -r l id m; do emit "$l" "$id" "$m"; done
import json, subprocess, time
def g(p): return json.loads(subprocess.run(["pvesh","get",p,"--output-format","json"],capture_output=True,text=True).stdout or "[]")
jobs=[j for j in g("/cluster/backup") if j.get("enabled",1)]
guests=[r for r in g("/cluster/resources?type=vm") if not r.get("template")]
covered=set()
for j in jobs:
    if j.get("all"): covered |= {r["vmid"] for r in guests} - {int(x) for x in str(j.get("exclude","")).split(",") if x}
    for x in str(j.get("vmid","")).split(","):
        if x.strip().isdigit(): covered.add(int(x))
unprot=[str(r["vmid"]) for r in guests if r["vmid"] not in covered and r["vmid"] < 99000]
print(("OK|backup-coverage|all %d guests in a backup job"%len(guests)) if not unprot else "WARN|backup-coverage|not in any backup job: "+",".join(unprot))
if not jobs: print("WARN|backup-jobs|no enabled backup jobs")
# last vzdump task per guest within 48h
tasks=g("/cluster/tasks")
recent={}
for t in tasks:
    if t.get("type")=="vzdump" and t.get("id"):
        recent.setdefault(str(t["id"]), t)
stale=[]
now=time.time()
for r in guests:
    if r["vmid"]>=99000 or r["vmid"] not in covered: continue
    t=recent.get(str(r["vmid"]))
    if t and t.get("status")!="OK": stale.append(f'{r["vmid"]}(failed)')
for s in stale: print("WARN|backup-result|last backup failed: "+s)
PY
}

check_pmxcfs; check_time; check_repos; check_updates; check_uplink_fc; check_corosync; check_certs; check_udev; check_ssh_fallback; check_disks
if ((NODE_ONLY == 0)); then check_quorum; check_ceph; check_storage; check_ha; check_firewall; check_backups; fi
exit $WORST
