#!/usr/bin/env bash
# galley-lxc.sh — install galley into a small unprivileged Debian LXC on a PVE node.
#
#   bash galley-lxc.sh --id 150 --storage vm-pool --bridge vmbr0 --ip dhcp [options]
#   bash galley-lxc.sh --upgrade --id 150 [--version vX.Y.Z | --binary PATH]
#
# Options:
#   --id N              container ID (required; refuses if taken anywhere in the cluster)
#   --storage NAME      rootfs storage (required if more than one candidate)
#   --bridge NAME       bridge or SDN vnet (default vmbr0)
#   --ip dhcp|CIDR      default dhcp;  --gw IP  --dns IP
#   --hostname NAME     default galley
#   --binary PATH       install this galley binary (default: latest GitHub release)
#   --version vX.Y.Z    release to download (default: latest)
#   --create-token      also create user galley@pve with PVEAuditor on / and token
#                       galley@pve!poller, and print its secret (shown once)
#   --ssh-key FILE      authorize this public key for root in the container
#   --upgrade           replace the binary in the existing galley CT --id (on this
#                       node) and restart the service; creates nothing
set -Eeuo pipefail

REPO="JongoDB/pve-cookbook"
ID="" STORAGE="" BRIDGE="vmbr0" IP="dhcp" GW="" DNS="" HOST="galley" BIN="" VER="latest" TOKEN=0 KEY="" UPGRADE=0
die() { echo "error: $*" >&2; exit 1; }
need() { [[ $# -ge 2 && -n "$2" ]] || die "$1 needs a value"; }
while (($#)); do case "$1" in
  --id) need "$@"; ID="$2"; shift 2 ;; --storage) need "$@"; STORAGE="$2"; shift 2 ;;
  --bridge) need "$@"; BRIDGE="$2"; shift 2 ;; --ip) need "$@"; IP="$2"; shift 2 ;;
  --gw) need "$@"; GW="$2"; shift 2 ;; --dns) need "$@"; DNS="$2"; shift 2 ;;
  --hostname) need "$@"; HOST="$2"; shift 2 ;; --binary) need "$@"; BIN="$2"; shift 2 ;;
  --version) need "$@"; VER="$2"; shift 2 ;; --ssh-key) need "$@"; KEY="$2"; shift 2 ;;
  --create-token) TOKEN=1; shift ;; --upgrade) UPGRADE=1; shift ;;
  -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown option $1" ;; esac; done

command -v pct >/dev/null || die "run on a Proxmox VE node"
[[ -n "$ID" ]] || die "--id required"
[[ "$ID" =~ ^[0-9]+$ ]] || die "--id must be a number"
[[ -z "$KEY" || -r "$KEY" ]] || die "--ssh-key file not readable: $KEY"
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac

# vmid_in_use ID: true if any VM/CT with this ID exists anywhere in the cluster.
vmid_in_use() {
  local json
  json="$(pvesh get /cluster/resources --type vm --output-format json 2>/dev/null)" \
    || die "could not list cluster resources (pvesh get /cluster/resources)"
  python3 -c 'import json,sys
want=int(sys.argv[1])
sys.exit(0 if any(int(r.get("vmid",-1))==want for r in json.load(sys.stdin)) else 1)' "$1" <<<"$json"
}

# binary: download (sha256-verified) unless --binary was given
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fetch_binary() {
  local url want got
  url="https://github.com/$REPO/releases/latest/download/galley-linux-$ARCH"
  [[ "$VER" != latest ]] && url="https://github.com/$REPO/releases/download/$VER/galley-linux-$ARCH"
  echo ">> downloading $url"
  curl -fsSL -o "$TMP/galley" "$url" || die "download failed (no release yet? use --binary)"
  curl -fsSL -o "$TMP/SHA256SUMS" "${url%/*}/SHA256SUMS" || die "could not fetch SHA256SUMS for verification"
  want="$(awk -v f="galley-linux-$ARCH" '$2==f || $2=="*"f {print $1}' "$TMP/SHA256SUMS")"
  got="$(sha256sum "$TMP/galley" | awk '{print $1}')"
  [[ -n "$want" && "$want" == "$got" ]] || die "checksum mismatch for galley-linux-$ARCH (want ${want:-none}, got $got)"
  echo ">> sha256 verified ($got)"
  BIN="$TMP/galley"
}

# ---------------------------------------------------------------- upgrade mode
if ((UPGRADE)); then
  pct status "$ID" >/dev/null 2>&1 || die "CT $ID not found on this node (run --upgrade on the node that hosts it)"
  st="$(pct status "$ID" 2>/dev/null || true)"
  [[ "$st" == *"status: running"* ]] || die "CT $ID is not running (pct start $ID first)"
  pct exec "$ID" -- test -x /usr/local/bin/galley || die "CT $ID has no /usr/local/bin/galley; not a galley CT?"
  pct exec "$ID" -- test -f /etc/systemd/system/galley.service || die "CT $ID has no galley.service; not a galley CT?"
  if [[ -z "$BIN" ]]; then fetch_binary; fi
  [[ -f "$BIN" ]] || die "binary not found: $BIN"
  OLD="$(pct exec "$ID" -- /usr/local/bin/galley --version 2>&1 || echo unknown)"
  echo ">> pushing new binary to CT $ID"
  pct push "$ID" "$BIN" /usr/local/bin/galley.new --perms 0755
  pct exec "$ID" -- bash -se <<'IN'
set -e
/usr/local/bin/galley.new --version >/dev/null || { rm -f /usr/local/bin/galley.new; echo "new binary does not run" >&2; exit 1; }
mv -f /usr/local/bin/galley.new /usr/local/bin/galley
systemctl restart galley
IN
  NEW="$(pct exec "$ID" -- /usr/local/bin/galley --version 2>&1 || echo unknown)"
  ok=0
  for _ in $(seq 15); do pct exec "$ID" -- systemctl is-active -q galley && { ok=1; break; }; sleep 1; done
  printf '\ngalley upgraded in CT %s.\n  old: %s\n  new: %s\n' "$ID" "$OLD" "$NEW"
  ((ok)) || echo "!! galley.service is not active; check: pct exec $ID -- journalctl -u galley -n 50"
  exit 0
fi

# ----------------------------------------------------------- fresh install mode
if pct status "$ID" >/dev/null 2>&1 || qm status "$ID" >/dev/null 2>&1 || vmid_in_use "$ID"; then
  die "ID $ID in use in the cluster"
fi
[[ -e "/sys/class/net/$BRIDGE" ]] || die "bridge/vnet $BRIDGE not present on this node"
if [[ -z "$STORAGE" ]]; then
  mapfile -t cands < <(pvesm status -content rootdir 2>/dev/null | awk 'NR>1 && $3=="active"{print $1}')
  case "${#cands[@]}" in
    0) die "no active storage with content 'rootdir' on this node; enable one or pass --storage" ;;
    1) STORAGE="${cands[0]}" ;;
    *) die "--storage required; candidates: ${cands[*]}" ;;
  esac
fi

if [[ -z "$BIN" ]]; then fetch_binary; fi
[[ -f "$BIN" ]] || die "binary not found: $BIN"

# template: Debian 13 standard for this node's architecture
TS="$(pvesm status -content vztmpl 2>/dev/null | awk 'NR>1 && $3=="active"{print $1; exit}')"
[[ -n "$TS" ]] || die "no active storage with content 'vztmpl' (container templates) on this node"
pveam update >/dev/null 2>&1 || true
avail="$(pveam available --section system 2>/dev/null || true)"
T="$(awk -v a="$ARCH" '$2 ~ "^debian-13-standard_.*_" a "\\.tar" {print $2}' <<<"$avail" | sort -V | tail -n1)"
[[ -n "$T" ]] || die "no debian-13-standard template for $ARCH in 'pveam available' (try: pveam update)"
have="$(pveam list "$TS" 2>/dev/null || true)"
if ! grep -qF "$T" <<<"$have"; then
  echo ">> downloading template $T to $TS"
  pveam download "$TS" "$T" >/dev/null || die "template download failed: $T"
fi
NET="name=eth0,bridge=$BRIDGE,ip=$IP"; [[ -n "$GW" ]] && NET+=",gw=$GW"

echo ">> creating CT $ID ($HOST) on $STORAGE / $BRIDGE"
pct create "$ID" "$TS:vztmpl/$T" --hostname "$HOST" --unprivileged 1 --features nesting=1 \
  --cores 1 --memory 512 --swap 256 --rootfs "$STORAGE:4" --net0 "$NET" \
  ${DNS:+--nameserver "$DNS"} ${KEY:+--ssh-public-keys "$KEY"} \
  --onboot 1 --tags galley --description "galley cockpit (pve-cookbook)" >/dev/null
pct start "$ID"
for _ in $(seq 30); do pct exec "$ID" -- true 2>/dev/null && break; sleep 1; done

pct push "$ID" "$BIN" /usr/local/bin/galley --perms 0755
pct exec "$ID" -- bash -se <<'IN'
set -e
id galley >/dev/null 2>&1 || useradd --system --home /var/lib/galley --shell /usr/sbin/nologin galley
install -d -o galley -g galley -m 0700 /var/lib/galley
cat >/etc/systemd/system/galley.service <<'U'
[Unit]
Description=galley cockpit for Proxmox VE
After=network-online.target
Wants=network-online.target
[Service]
User=galley
ExecStart=/usr/local/bin/galley --listen :8443 --data /var/lib/galley
Restart=on-failure
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/galley
PrivateTmp=yes
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
U
systemctl daemon-reload
systemctl enable -q --now galley
IN

for _ in $(seq 20); do pct exec "$ID" -- test -f /var/lib/galley/tls.crt && break; sleep 1; done
SETUP=""
for _ in $(seq 20); do  # one-time setup code, written on first start when no cluster is registered
  if pct exec "$ID" -- test -s /var/lib/galley/setup-token 2>/dev/null; then
    SETUP="$(pct exec "$ID" -- cat /var/lib/galley/setup-token 2>/dev/null | tr -d '[:space:]' || true)"
    [[ -n "$SETUP" ]] && break
  fi
  sleep 1
done
CTIP=""
for _ in $(seq 30); do  # wait for the IPv4 lease (DHCP); hostname -I may list IPv6 first
  CTIP="$(pct exec "$ID" -- ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"
  [[ -n "$CTIP" ]] && break; sleep 1
done
[[ -n "$CTIP" ]] || CTIP="$(pct exec "$ID" -- hostname -I 2>/dev/null | awk '{print $1}' || true)"
[[ -n "$CTIP" ]] || CTIP="<container-ip>"
[[ "$CTIP" == *:* ]] && CTIP="[$CTIP]"
FP="$(pct exec "$ID" -- openssl x509 -in /var/lib/galley/tls.crt -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)"
NODEIP="$(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -n1 || true)"

if ((TOKEN)); then
  users="$(pveum user list --output-format json)"
  grep -q '"userid":"galley@pve"' <<<"$users" || pveum user add galley@pve --comment "galley read-only poller"
  pveum acl modify / --users galley@pve --roles PVEAuditor
  tokens="$(pveum user token list galley@pve --output-format json 2>/dev/null || true)"
  if grep -q '"tokenid":"poller"' <<<"$tokens"; then
    echo "!! token galley@pve!poller already exists; delete it to re-issue: pveum user token remove galley@pve poller"
  else
    SECRET="$(pveum user token add galley@pve poller --privsep 0 --comment galley --output-format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["value"])')"
  fi
fi

cat <<EOF

galley is running.
  URL:          https://$CTIP:8443
  TLS (sha256): ${FP:-unknown (pct exec $ID -- openssl x509 -in /var/lib/galley/tls.crt -noout -fingerprint -sha256)}
  Setup:        add this cluster's nodes (e.g. ${NODEIP:-the node IPs}), confirm their fingerprints,
                then enter the service token below. Log in with your normal PVE account.
EOF
if [[ -n "$SETUP" ]]; then
  printf '  Setup code:   %s   (needed once, to register the first cluster)\n' "$SETUP"
else
  printf '  Setup code:   not found yet; see: pct exec %s -- journalctl -u galley\n' "$ID"
fi
if [[ -n "${SECRET:-}" ]]; then
  printf '  Token ID:     galley@pve!poller\n  Token secret: %s   (shown once)\n' "$SECRET"
fi
