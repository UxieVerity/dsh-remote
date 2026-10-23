#!/usr/bin/env bash
# Remove one PC's nginx block and portal/registry entries.
# Run as root. This does not touch the remote Windows PC.
#
# Usage:
#   sudo bash scripts/server/remove-pc.sh --name pc-c
set -euo pipefail

STATE_DIR="/etc/dsh-relay"
REGISTRY="$STATE_DIR/pcs.tsv"
PCS_DIR="/etc/nginx/dsh-pcs"
PCS_JSON="/srv/dsh-portal/pcs.json"

NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    -h|--help) echo "usage: $0 --name pc-c"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ ! "$NAME" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$ ]]; then
  echo "invalid name" >&2
  exit 1
fi
if ! command -v nginx >/dev/null; then
  echo "nginx is required" >&2
  exit 1
fi
if ! command -v python3 >/dev/null; then
  echo "python3 is required" >&2
  exit 1
fi

CONF="$PCS_DIR/${NAME}.conf"
REG_BACKUP="$(mktemp)"
JSON_BACKUP="$(mktemp)"
CONF_BACKUP="$(mktemp)"
HAD_CONF=0
[[ -f "$CONF" ]] && HAD_CONF=1
cp -a "$REGISTRY" "$REG_BACKUP" 2>/dev/null || : > "$REG_BACKUP"
cp -a "$PCS_JSON" "$JSON_BACKUP" 2>/dev/null || printf '[]\n' > "$JSON_BACKUP"
[[ "$HAD_CONF" -eq 1 ]] && cp -a "$CONF" "$CONF_BACKUP"

trap 'rm -f "$REG_BACKUP" "$JSON_BACKUP" "$CONF_BACKUP"' EXIT

rm -f "$CONF"
if [[ -f "$REGISTRY" ]]; then
  awk -F '\t' -v n="$NAME" '$1 != n' "$REGISTRY" > "${REGISTRY}.tmp"
  mv "${REGISTRY}.tmp" "$REGISTRY"
  chmod 0644 "$REGISTRY"
fi

if [[ -f "$PCS_JSON" ]] && command -v python3 >/dev/null; then
  NAME="$NAME" python3 - "$PCS_JSON" <<'PY'
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
try:
    entries = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    entries = []
if not isinstance(entries, list):
    entries = []
entries = [e for e in entries if not (isinstance(e, dict) and e.get("id") == os.environ["NAME"])]
path.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
  chown root:www-data "$PCS_JSON" 2>/dev/null || true
  chmod 0644 "$PCS_JSON"
fi

if ! nginx -t; then
  cp -a "$REG_BACKUP" "$REGISTRY" 2>/dev/null || true
  cp -a "$JSON_BACKUP" "$PCS_JSON" 2>/dev/null || true
  chmod 0644 "$REGISTRY" "$PCS_JSON" 2>/dev/null || true
  chown root:www-data "$PCS_JSON" 2>/dev/null || true
  if [[ "$HAD_CONF" -eq 1 ]]; then
    cp -a "$CONF_BACKUP" "$CONF"
  fi
  nginx -t >/dev/null 2>&1 || true
  echo "nginx -t failed; rolled back" >&2
  exit 1
fi
systemctl reload nginx

echo "removed: ${NAME}"
echo "The Windows task/frpc on that PC is still running; stop it separately."
