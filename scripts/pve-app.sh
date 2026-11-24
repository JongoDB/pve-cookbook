#!/usr/bin/env bash
# pve-app.sh — non-interactive wrapper around community-scripts/ProxmoxVE (MIT).
# Run on a PVE node. Upstream scripts are fetched at run time, never vendored.
#
#   pve-app.sh search <term>                 search the live catalog
#   pve-app.sh info <slug>                   resources, port, app options, script path
#   pve-app.sh deploy <slug> [options]       create the LXC/VM unattended
#
# deploy options (CT):
#   --id N            CT/VM ID (required; refuses if taken — upstream would silently pick another)
#   --hostname NAME   default: slug
#   --cpu N --ram MiB --disk GiB      default: app's declared minimums
#   --vnet NAME | --bridge NAME       network attachment (SDN vnet preferred)
#   --ip dhcp|CIDR  --gw IP  --dns IP
#   --storage NAME    rootfs/VM disk storage (required when >1 candidate exists)
#   --template-storage NAME           where CT templates are cached (default: first with vztmpl)
#   --ssh-key FILE    install this public key for root
#   --set KEY=VAL     pass any extra upstream var (e.g. --set var_docker_compose=yes), repeatable
#   --os debian|ubuntu|alpine  --os-version V
#   --pin SHA_PVE:SHA_CORE   pin both upstream repos (reproducible installs)
#   --telemetry       opt IN to upstream diagnostics (default: opted out)
#   --dry-run         print the command that would run
set -Eeuo pipefail

API="https://db.community-scripts.org/api/collections"
RAW="https://raw.githubusercontent.com/community-scripts"
STATE=/usr/local/community-scripts

die() { echo "error: $*" >&2; exit 1; }
api() { curl -fsSL --max-time 20 "$API/$1"; }

catalog_query() { # <pocketbase filter>
  api "script_scripts/records?perPage=500&expand=type&filter=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1")"
}

PY_SEARCH=$(cat <<'PY'
import json, sys
d = json.load(sys.stdin)["items"]
for r in sorted(d, key=lambda r: r["slug"]):
    t = (r.get("expand") or {}).get("type", {}).get("type", "?")
    flag = " [disabled]" if r.get("is_disabled") else ""
    print(f"{r['slug']:<28} {t:<8} {r['name']}{flag}")
print(f"-- {len(d)} result(s)", file=sys.stderr)
PY
)

PY_INFO=$(cat <<'PY'
import json, sys
r = json.loads(sys.argv[1]); t = (r.get("expand") or {}).get("type", {}).get("type", "?")
print(f"{r['name']} ({r['slug']}) type={t} port={r.get('port')} privileged={r.get('privileged')}")
print((r.get("description") or "").strip()[:400])
for m in r.get("install_methods") or []:
    res = m.get("resources") or {}
    script = m.get("script") or f"ct/{r['slug']}.sh"
    print(f"  method={m.get('type')} script={script} cpu={res.get('cpu')} ram={res.get('ram')}MiB disk={res.get('hdd')}GiB os={res.get('os')} {res.get('version')}")
for v in r.get("app_vars") or []:
    print(f"  --set {v['name']}=<{v.get('type')}> default={v.get('default')} options={v.get('options')}  # {v.get('label')}")
if r.get("default_user"):
    print(f"  default credentials: {r['default_user']} / {r.get('default_passwd')}")
for n in r.get("notes") or []:
    print("  note:", n.get("text", n) if isinstance(n, dict) else n)
if r.get("is_disabled"):
    print("  DISABLED upstream:", r.get("disable_message"))
PY
)

PY_META=$(cat <<'PY'
import json, sys
r = json.loads(sys.argv[1]); t = (r.get("expand") or {}).get("type", {}).get("type", "lxc")
m = (r.get("install_methods") or [{}])[0]
s = m.get("script") or (f"ct/{r['slug']}.sh" if t in ("lxc", "turnkey") else f"vm/{r['slug']}.sh")
print(t, s, "yes" if r.get("is_disabled") else "no")
PY
)

cmd_search() {
  local term="${1:?usage: search <term>}"
  catalog_query "(name~'$term' || slug~'$term' || description~'$term') && is_deleted=false" | python3 -c "$PY_SEARCH"
}

app_json() { catalog_query "slug='$1'" | python3 -c 'import json,sys; i=json.load(sys.stdin)["items"]; print(json.dumps(i[0]) if i else "")'; }

cmd_info() {
  local j; j="$(app_json "${1:?usage: info <slug>}")"; [[ -n "$j" ]] || die "no such app: $1"
  python3 -c "$PY_INFO" "$j"
}

cmd_deploy() {
  local slug="${1:?usage: deploy <slug> [options]}"; shift
  local id="" host="" cpu="" ram="" disk="" vnet="" bridge="" ip="dhcp" gw="" dns="" storage="" tstorage="" key="" os="" osv="" pin="" telemetry=0 dry=0
  local extra=()
  while (($#)); do case "$1" in
    --id) id="$2"; shift 2 ;; --hostname) host="$2"; shift 2 ;;
    --cpu) cpu="$2"; shift 2 ;; --ram) ram="$2"; shift 2 ;; --disk) disk="$2"; shift 2 ;;
    --vnet) vnet="$2"; shift 2 ;; --bridge) bridge="$2"; shift 2 ;;
    --ip) ip="$2"; shift 2 ;; --gw) gw="$2"; shift 2 ;; --dns) dns="$2"; shift 2 ;;
    --storage) storage="$2"; shift 2 ;; --template-storage) tstorage="$2"; shift 2 ;;
    --ssh-key) key="$(cat "$2")"; shift 2 ;; --os) os="$2"; shift 2 ;; --os-version) osv="$2"; shift 2 ;;
    --set) extra+=("$2"); shift 2 ;; --pin) pin="$2"; shift 2 ;;
    --telemetry) telemetry=1; shift ;; --dry-run) dry=1; shift ;;
    *) die "unknown option $1" ;; esac; done

  command -v pveversion >/dev/null || die "run this on a Proxmox VE node"
  [[ -n "$id" ]] || die "--id is required"
  if qm status "$id" >/dev/null 2>&1 || pct status "$id" >/dev/null 2>&1; then die "ID $id is already in use"; fi

  local j; j="$(app_json "$slug")"; [[ -n "$j" ]] || die "no such app: $slug"
  local type script disabled
  read -r type script disabled < <(python3 -c "$PY_META" "$j")
  [[ "$disabled" == no ]] || die "$slug is disabled upstream (see: pve-app.sh info $slug)"

  if [[ -z "$storage" ]]; then
    local cands; cands="$(pvesm status -content "$([[ $type == vm ]] && echo images || echo rootdir)" | awk 'NR>1 && $3=="active"{print $1}')"
    [[ "$(wc -l <<<"$cands")" == 1 ]] && storage="$cands" || die "--storage required; candidates: $(tr '\n' ' ' <<<"$cands")"
  fi
  [[ -n "$tstorage" ]] || tstorage="$(pvesm status -content vztmpl | awk 'NR>1 && $3=="active"{print $1; exit}')"
  [[ -z "$vnet" || -e "/sys/class/net/$vnet" ]] || die "vnet '$vnet' not applied on this node (pvesh set /cluster/sdn)"

  mkdir -p "$STATE"
  if ((telemetry)); then echo "DIAGNOSTICS=yes" >"$STATE/diagnostics"
  elif [[ ! -f "$STATE/diagnostics" ]]; then echo "DIAGNOSTICS=no" >"$STATE/diagnostics"; fi

  local base_pve="$RAW/ProxmoxVE/main" base_core="$RAW/core/main"
  if [[ -n "$pin" ]]; then base_pve="$RAW/ProxmoxVE/${pin%%:*}"; base_core="$RAW/core/${pin##*:}"; fi

  local env=()
  if [[ "$type" == vm ]]; then
    env+=(VM_UNATTENDED=1 "VM_VMID=$id" "VM_HOSTNAME=${host:-$slug}" "VM_STORAGE=$storage" VM_START=yes)
    [[ -n "$cpu" ]]  && env+=("VM_CORES=$cpu");  [[ -n "$ram" ]] && env+=("VM_RAM=$ram")
    [[ -n "$disk" ]] && env+=("VM_DISK_SIZE=${disk}G")
    env+=("VM_BRIDGE=${vnet:-${bridge:-vmbr0}}")
  else
    env+=(mode=generated PHS_SILENT=1 "var_ctid=$id" "var_hostname=${host:-$slug}" var_unprivileged=1
          "var_container_storage=$storage" "var_template_storage=$tstorage" "var_net=$ip")
    [[ -n "$cpu" ]]  && env+=("var_cpu=$cpu");   [[ -n "$ram" ]] && env+=("var_ram=$ram"); [[ -n "$disk" ]] && env+=("var_disk=$disk")
    [[ -n "$vnet" ]] && env+=("var_sdn_vnet=$vnet") || env+=("var_brg=${bridge:-vmbr0}")
    [[ -n "$gw" ]]   && env+=("var_gateway=$gw"); [[ -n "$dns" ]] && env+=("var_ns=$dns")
    [[ -n "$os" ]]   && env+=("var_os=$os");      [[ -n "$osv" ]] && env+=("var_version=$osv")
    [[ -n "$key" ]]  && env+=(var_ssh=yes "var_ssh_authorized_key=$key")
  fi
  env+=("TERM=${TERM:-xterm}" "COMMUNITY_SCRIPTS_URL=$base_pve" "COMMUNITY_SCRIPTS_CORE_URL=$base_core" "${extra[@]}")

  local url="$base_pve/$script"
  if ((dry)); then printf '%q ' env "${env[@]}"; printf 'bash -c "$(curl -fsSL %s)"\n' "$url"; return 0; fi
  echo ">> deploying $slug ($type) as $id from $url"
  env "${env[@]}" bash -c "$(curl -fsSL "$url")" </dev/null
  if [[ "$type" == vm ]]; then qm status "$id"; else pct status "$id" && pct exec "$id" -- hostname -I || true; fi
}

case "${1:-}" in
  search) shift; cmd_search "$@" ;;
  info)   shift; cmd_info "$@" ;;
  deploy) shift; cmd_deploy "$@" ;;
  *) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
