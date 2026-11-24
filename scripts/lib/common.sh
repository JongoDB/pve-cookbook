#!/usr/bin/env bash
# Shared helpers for pvecb steps. Sourced, never executed.
# Requirements on the operator machine: bash, ssh, python3 (PyYAML optional —
# if missing, the inventory is converted on the founder node, which ships PyYAML).

set -Eeuo pipefail

PVECB_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PVECB_DRY_RUN="${PVECB_DRY_RUN:-0}"
PVECB_YES="${PVECB_YES:-0}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=6)

# ---------- logging ----------
if [[ -t 1 ]]; then C_B=$'\e[1m'; C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_D=$'\e[2m'; C_0=$'\e[0m'
else C_B=; C_G=; C_Y=; C_R=; C_D=; C_0=; fi
step() { printf '%s==> %s%s\n' "$C_B" "$*" "$C_0"; }
ok()   { printf '%s  ✓ %s%s\n' "$C_G" "$*" "$C_0"; }
warn() { printf '%s  ! %s%s\n' "$C_Y" "$*" "$C_0" >&2; }
die()  { printf '%s  ✗ %s%s\n' "$C_R" "$*" "$C_0" >&2; exit 1; }
info() { printf '%s    %s%s\n' "$C_D" "$*" "$C_0"; }

# ---------- inventory ----------
# Converted once to JSON; queried with `q`.
INVENTORY="${INVENTORY:-$PVECB_ROOT/inventory.yaml}"
INV_JSON=""

_yaml2json_py='import sys,json,yaml; print(json.dumps(yaml.safe_load(sys.stdin)))'

load_inventory() {
  [[ -f "$INVENTORY" ]] || die "inventory not found: $INVENTORY (copy inventory.example.yaml)"
  INV_JSON="$(mktemp "${TMPDIR:-/tmp}/pvecb-inv.XXXXXX")"
  trap 'rm -f "$INV_JSON"' EXIT
  if python3 -c 'import yaml' 2>/dev/null; then
    python3 -c "$_yaml2json_py" <"$INVENTORY" >"$INV_JSON"
  else
    # Fall back to the first node listed (PVE ships PyYAML).
    local first
    first="$(awk '/^[[:space:]]*ssh:[[:space:]]*/{print $2; exit}' "$INVENTORY")"
    [[ -n "$first" ]] || die "no PyYAML locally and no nodes[].ssh found to convert inventory"
    ssh "${SSH_OPTS[@]}" "$first" "python3 -c '$_yaml2json_py'" <"$INVENTORY" >"$INV_JSON" \
      || die "could not convert inventory via $first"
  fi
}

# q <path> [default]
#   path: dotted keys, list index [0], wildcard [*], or selector [name=pve1]
#   scalars print raw; lists of scalars print one per line; objects print JSON.
q() {
  python3 - "$INV_JSON" "$1" "${2-__PVECB_NODEFAULT__}" <<'PY'
import json, re, sys
data = json.load(open(sys.argv[1])); path = sys.argv[2]; default = sys.argv[3]
toks = re.findall(r'[^.\[\]]+|\[[^\]]*\]', path)
cur = [data]
for t in toks:
    nxt = []
    for c in cur:
        if t.startswith('['):
            s = t[1:-1]
            if s == '*' and isinstance(c, list): nxt += c
            elif s.isdigit() and isinstance(c, list) and int(s) < len(c): nxt.append(c[int(s)])
            elif '=' in s and isinstance(c, list):
                k, v = s.split('=', 1); nxt += [i for i in c if isinstance(i, dict) and str(i.get(k)) == v]
        elif isinstance(c, dict) and t in c and c[t] is not None:
            nxt.append(c[t])
    cur = nxt
if not cur:
    if default == '__PVECB_NODEFAULT__': sys.exit(f"inventory: missing required key '{path}'")
    print(default); sys.exit(0)
def out(v):
    if isinstance(v, bool): print('true' if v else 'false')
    elif isinstance(v, (dict,)): print(json.dumps(v))
    elif isinstance(v, list):
        for i in v: out(i)
    else: print(v)
for v in cur: out(v)
PY
}

nodes()          { q 'nodes[*].name'; }
node_field()     { q "nodes[name=$1].$2" "${3-}"; }
founder()        { q 'cluster.founder' "$(nodes | head -1)"; }
is_true()        { [[ "$1" == "true" || "$1" == "1" || "$1" == "yes" ]]; }

# ---------- remote execution ----------
# on <node> <script...>   run bash on a node (stdin script supported with -)
on() {
  local node="$1"; shift
  local target; target="$(node_field "$node" ssh)"
  if [[ "$PVECB_DRY_RUN" == "1" ]]; then
    printf '%s[dry-run %s]%s %s\n' "$C_Y" "$node" "$C_0" "$*"; return 0
  fi
  ssh "${SSH_OPTS[@]}" "$target" "bash -se" <<<"set -Eeuo pipefail; $*"
}

# Read-only remote command that runs even in dry-run mode.
peek() {
  local node="$1"; shift
  ssh "${SSH_OPTS[@]}" "$(node_field "$node" ssh)" "bash -se" <<<"$*"
}

on_all() { local n; for n in $(nodes); do on "$n" "$@"; done; }

# on_fn <node> <function> [args...]
#   Ship a locally defined bash function to the node and run it with args.
#   Lets remote logic be written as normal, lintable bash instead of quoted strings.
_fn_script() { local fn="$1"; shift; printf '%s\n%s' "$(declare -f "$fn")" "$fn"; printf ' %q' "$@"; }
on_fn()   { local node="$1"; shift; on   "$node" "$(_fn_script "$@")"; }
peek_fn() { local node="$1"; shift; peek "$node" "$(_fn_script "$@")"; }

confirm() {
  # confirm "<what will happen>"  — requires --yes for non-interactive runs
  [[ "$PVECB_YES" == "1" ]] && return 0
  if [[ -t 0 ]]; then
    read -r -p "  ? $1 — type 'yes' to continue: " a; [[ "$a" == "yes" ]] || die "aborted"
  else
    die "refusing destructive action without --yes: $1"
  fi
}

# Wait until a remote predicate succeeds: wait_for <node> <timeout-s> <cmd>
wait_for() {
  local node="$1" t="$2"; shift 2
  [[ "$PVECB_DRY_RUN" == "1" ]] && return 0
  local end=$((SECONDS + t))
  until peek "$node" "$*" >/dev/null 2>&1; do
    (( SECONDS < end )) || return 1; sleep 3
  done
}

# /etc/pve writability check that cannot hang the caller. A wedged pmxcfs puts
# writers into uninterruptible sleep (D state) where even SIGKILL/timeout wait
# forever, so the probe is backgrounded and abandoned if it does not finish.
pmxcfs_ok() {
  peek "$1" '
    f=/etc/pve/.pvecb-wt.$$
    ( touch "$f" && rm -f "$f" ) & p=$!
    for _ in $(seq 20); do
      kill -0 $p 2>/dev/null || { wait $p; exit $?; }
      sleep 0.25
    done
    echo "pmxcfs write did not complete within 5s (wedged?)" >&2; exit 1'
}
