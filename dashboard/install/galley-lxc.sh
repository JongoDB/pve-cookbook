#!/usr/bin/env bash
# galley-lxc.sh — install galley into a small unprivileged Debian LXC on a PVE node.
#
#   bash galley-lxc.sh --id 150 --storage vm-pool --bridge vmbr0 --ip dhcp [options]
#
# Options:
#   --id N              container ID (required; refuses if taken)
#   --storage NAME      rootfs storage (required if more than one candidate)
#   --bridge NAME       bridge or SDN vnet (default vmbr0)
#   --ip dhcp|CIDR      default dhcp;  --gw IP  --dns IP
#   --hostname NAME     default galley
#   --binary PATH       install this galley binary (default: latest GitHub release)
#   --version vX.Y.Z    release to download (default: latest)
#   --create-token      also create user galley@pve with PVEAuditor on / and token
#                       galley@pve!poller, and print its secret (shown once)
#   --ssh-key FILE      authorize this key for root in the container
set -Eeuo pipefail

REPO="JongoDB/pve-cookbook"
ID="" STORAGE="" BRIDGE="vmbr0" IP="dhcp" GW="" DNS="" HOST="galley" BIN="" VER="latest" TOKEN=0 KEY=""
die() { echo "error: $*" >&2; exit 1; }
while (($#)); do case "$1" in
  --id) ID="$2"; shift 2 ;; --storage) STORAGE="$2"; shift 2 ;; --bridge) BRIDGE="$2"; shift 2 ;;
  --ip) IP="$2"; shift 2 ;; --gw) GW="$2"; shift 2 ;; --dns) DNS="$2"; shift 2 ;;
  --hostname) HOST="$2"; shift 2 ;; --binary) BIN="$2"; shift 2 ;; --version) VER="$2"; shift 2 ;;
  --create-token) TOKEN=1; shift ;; --ssh-key) KEY="$2"; shift 2 ;;
  -h|--help) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "unknown option $1" ;; esac; done

command -v pct >/dev/null || die "run on a Proxmox VE node"
[[ -n "$ID" ]] || die "--id required"
if pct status "$ID" >/dev/null 2>&1 || qm status "$ID" >/dev/null 2>&1; then die "ID $ID in use"; fi
[[ -e "/sys/class/net/$BRIDGE" ]] || die "bridge/vnet $BRIDGE not present on this node"
if [[ -z "$STORAGE" ]]; then
  c="$(pvesm status -content rootdir | awk 'NR>1 && $3=="active"{print $1}')"
  [[ "$(wc -l <<<"$c")" == 1 ]] && STORAGE="$c" || die "--storage required; candidates: $(tr '\n' ' ' <<<"$c")"
fi

# binary
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
case "$(uname -m)" in x86_64) ARCH=amd64 ;; aarch64) ARCH=arm64 ;; *) die "unsupported arch" ;; esac
if [[ -z "$BIN" ]]; then
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
fi
[[ -x "$BIN" || -f "$BIN" ]] || die "binary not found: $BIN"

# template
TS="$(pvesm status -content vztmpl | awk 'NR>1 && $3=="active"{print $1; exit}')"
pveam update >/dev/null 2>&1 || true
T="$(pveam available --section system | awk '/debian-13-standard.*amd64/{print $2}' | tail -1)"
pveam list "$TS" | grep -q "$T" || pveam download "$TS" "$T" >/dev/null
NET="name=eth0,bridge=$BRIDGE,ip=$IP"; [[ -n "$GW" ]] && NET+=",gw=$GW"

echo ">> creating CT $ID ($HOST) on $STORAGE / $BRIDGE"
pct create "$ID" "$TS:vztmpl/$T" --hostname "$HOST" --unprivileged 1 --features nesting=1 \
  --cores 1 --memory 512 --swap 256 --rootfs "$STORAGE:4" --net0 "$NET" \
  ${DNS:+--nameserver "$DNS"} --onboot 1 --tags galley --description "galley cockpit (pve-cookbook)" >/dev/null
[[ -n "$KEY" ]] && pct set "$ID" --ssh-public-keys "$KEY" >/dev/null
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
CTIP=""
for _ in $(seq 30); do  # wait for the IPv4 lease (DHCP); hostname -I may list IPv6 first
  CTIP="$(pct exec "$ID" -- ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
  [[ -n "$CTIP" ]] && break; sleep 1
done
[[ -n "$CTIP" ]] || CTIP="$(pct exec "$ID" -- hostname -I | awk '{print $1}')"
[[ "$CTIP" == *:* ]] && CTIP="[$CTIP]"
FP="$(pct exec "$ID" -- openssl x509 -in /var/lib/galley/tls.crt -noout -fingerprint -sha256 | cut -d= -f2)"

if ((TOKEN)); then
  pveum user list --output-format json | grep -q '"userid":"galley@pve"' || pveum user add galley@pve --comment "galley read-only poller"
  pveum acl modify / --users galley@pve --roles PVEAuditor
  if pveum user token list galley@pve --output-format json | grep -q '"tokenid":"poller"'; then
    echo "!! token galley@pve!poller already exists; delete it to re-issue: pveum user token remove galley@pve poller"
  else
    SECRET="$(pveum user token add galley@pve poller --privsep 0 --comment galley --output-format json | python3 -c 'import json,sys;print(json.load(sys.stdin)["value"])')"
  fi
fi

cat <<EOF

galley is running.
  URL:          https://$CTIP:8443
  TLS (sha256): $FP
  Setup:        add this cluster's nodes (e.g. $(ip -4 -o addr show scope global | awk '{print $4}' | cut -d/ -f1 | head -1)), confirm their fingerprints,
                then enter the service token below. Log in with your normal PVE account.
EOF
if [[ -n "${SECRET:-}" ]]; then
  printf '  Token ID:     galley@pve!poller\n  Token secret: %s   (shown once)\n' "$SECRET"
fi
