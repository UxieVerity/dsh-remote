#!/usr/bin/env bash
# Read-only validation of the relay. Run on the Ubuntu server.
#
# Required:
#   BASE_DOMAIN
# Optional:
#   PORTAL_USER, PORTAL_PASSWORD  (if set, also checks authenticated portal access)
set -u

BASE_DOMAIN="${BASE_DOMAIN:-}"
PORTAL_USER="${PORTAL_USER:-}"
PORTAL_PASSWORD="${PORTAL_PASSWORD:-}"
FAIL=0

if [[ -z "$BASE_DOMAIN" ]]; then
  echo "BASE_DOMAIN is required" >&2
  exit 2
fi
command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }

check_code() {
  local label="$1" expected="$2" url="$3" use_auth="${4:-no}"
  local code
  if [[ "$use_auth" == "yes" ]]; then
    if [[ -z "$PORTAL_USER" || -z "$PORTAL_PASSWORD" ]]; then
      echo "SKIP $label (no portal credentials)"
      return
    fi
    code="$(curl -sS -o /dev/null --max-time 20 -w '%{http_code}' \
      -u "${PORTAL_USER}:${PORTAL_PASSWORD}" "$url" || true)"
  else
    code="$(curl -sS -o /dev/null --max-time 20 -w '%{http_code}' "$url" || true)"
  fi
  if [[ "$code" == "$expected" ]]; then
    echo "OK   $label -> $code"
  else
    echo "FAIL $label -> $code (expected $expected) $url"
    FAIL=1
  fi
}

echo "== services =="
systemctl is-enabled frps >/dev/null 2>&1 && echo "OK   frps enabled" || { echo "FAIL frps not enabled"; FAIL=1; }
systemctl is-active --quiet frps && echo "OK   frps active" || { echo "FAIL frps not active"; FAIL=1; }
systemctl is-active --quiet nginx && echo "OK   nginx active" || { echo "FAIL nginx not active"; FAIL=1; }
nginx -t >/dev/null 2>&1 && echo "OK   nginx syntax" || { echo "FAIL nginx -t"; FAIL=1; }

echo
echo "== listeners =="
ss -lntp 2>/dev/null | grep -E ':(80|443|7000|7500)\b' || true

echo
echo "== HTTPS =="
check_code "portal unauthenticated" 401 "https://dsh.${BASE_DOMAIN}/"
check_code "portal authenticated" 200 "https://dsh.${BASE_DOMAIN}/" yes
check_code "portal manifest" 200 "https://dsh.${BASE_DOMAIN}/manifest.webmanifest" yes
check_code "portal service worker" 200 "https://dsh.${BASE_DOMAIN}/sw.js" yes
check_code "pc-a login page" 200 "https://pc-a.${BASE_DOMAIN}/login"
check_code "pc-b login page" 200 "https://pc-b.${BASE_DOMAIN}/login"

echo
echo "== certificate =="
if [[ -f /etc/nginx/ssl/dsh-relay.pem ]]; then
  openssl x509 -in /etc/nginx/ssl/dsh-relay.pem -noout -enddate -subject -ext subjectAltName || true
else
  echo "FAIL missing /etc/nginx/ssl/dsh-relay.pem"
  FAIL=1
fi

echo
if [[ "$FAIL" -eq 0 ]]; then
  echo "RESULT: OK"
else
  echo "RESULT: FAIL (see above)"
fi
exit "$FAIL"
