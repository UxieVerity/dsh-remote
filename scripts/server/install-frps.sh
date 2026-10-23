#!/usr/bin/env bash
# Install frps on Ubuntu/Debian. Run as root.
#
# Required env:
#   FRP_TOKEN           32+ random bytes encoded as hex (64 hex chars recommended)
#   DASHBOARD_PASSWORD  strong dashboard password
# Optional:
#   FRP_VERSION         default 0.71.1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$ROOT/templates/frps.toml.template"
SERVICE="$ROOT/templates/frps.service"

FRP_VERSION="${FRP_VERSION:-0.71.1}"
FRP_TOKEN="${FRP_TOKEN:-}"
DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ -z "$FRP_TOKEN" || ${#FRP_TOKEN} -lt 32 ]]; then
  echo "FRP_TOKEN must be at least 32 characters (64 hex recommended)" >&2
  exit 1
fi
if [[ -z "$DASHBOARD_PASSWORD" ]]; then
  echo "DASHBOARD_PASSWORD is required" >&2
  exit 1
fi
if [[ ! -f "$TEMPLATE" || ! -f "$SERVICE" ]]; then
  echo "templates not found under $ROOT/templates" >&2
  exit 1
fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

case "$(uname -m)" in
  x86_64)  ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_linux_${ARCH}.tar.gz"
echo "downloading $URL"
curl -fL --retry 3 --connect-timeout 20 -o "$TMP/frp.tar.gz" "$URL"
tar -xzf "$TMP/frp.tar.gz" -C "$TMP"
install -m 0755 "$TMP/frp_${FRP_VERSION}_linux_${ARCH}/frps" /usr/local/bin/frps

if ! id -u frp >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin frp
fi

install -d -m 0750 /etc/frp
touch /var/log/frps.log
chown frp:frp /var/log/frps.log
chmod 0640 /var/log/frps.log

if [[ -f /etc/frp/frps.toml ]]; then
  cp -a /etc/frp/frps.toml "/etc/frp/frps.toml.bak.$(date +%Y%m%d-%H%M%S)"
fi

FRP_TOKEN="$FRP_TOKEN" DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" \
  python3 - "$TEMPLATE" /etc/frp/frps.toml <<'PY'
import os
import pathlib
import sys

src, dst = map(pathlib.Path, sys.argv[1:3])
text = src.read_text(encoding="utf-8")
text = text.replace("__FRP_TOKEN__", os.environ["FRP_TOKEN"])
text = text.replace("__DASHBOARD_PASSWORD__", os.environ["DASHBOARD_PASSWORD"])
dst.write_text(text, encoding="utf-8")
PY

chown root:frp /etc/frp/frps.toml
chmod 0640 /etc/frp/frps.toml

install -m 0644 "$SERVICE" /etc/systemd/system/frps.service
systemctl daemon-reload
systemctl enable --now frps
systemctl restart frps
sleep 2

if ! systemctl is-active --quiet frps; then
  journalctl -u frps -n 80 --no-pager >&2 || true
  exit 1
fi

frps verify -c /etc/frp/frps.toml
echo
echo "frps is active on 0.0.0.0:7000"
echo "dashboard: http://127.0.0.1:7500 (loopback only)"
echo "config:    /etc/frp/frps.toml (640 root:frp)"
echo "Store FRP_TOKEN and DASHBOARD_PASSWORD in your password manager."
