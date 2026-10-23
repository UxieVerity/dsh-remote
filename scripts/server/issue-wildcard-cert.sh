#!/usr/bin/env bash
# Issue (or renew) a wildcard certificate with a manual DNS-01 challenge.
#
# Required env:
#   BASE_DOMAIN   domain suffix, e.g. example.com
#   ACME_EMAIL    Let's Encrypt account email
#
# This is interactive: certbot prints a TXT value; add it at
# _acme-challenge.BASE_DOMAIN, wait for propagation, then press Enter.
set -euo pipefail

BASE_DOMAIN="${BASE_DOMAIN:-}"
ACME_EMAIL="${ACME_EMAIL:-}"
CERT_NAME="${CERT_NAME:-dsh-wildcard}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ -z "$BASE_DOMAIN" || -z "$ACME_EMAIL" ]]; then
  echo "BASE_DOMAIN and ACME_EMAIL are required" >&2
  exit 1
fi
command -v certbot >/dev/null || { echo "certbot is required" >&2; exit 1; }

# A manual authenticator cannot renew unattended; do not leave the timer armed.
if systemctl list-unit-files certbot.timer >/dev/null 2>&1; then
  systemctl disable --now certbot.timer 2>/dev/null || true
  echo "certbot.timer disabled (manual DNS challenge is interactive)."
fi

certbot certonly \
  --manual \
  --preferred-challenges dns \
  --cert-name "$CERT_NAME" \
  -d "*.${BASE_DOMAIN}" \
  --agree-tos \
  --email "$ACME_EMAIL" \
  --no-eff-email

CERT_DIR="/etc/letsencrypt/live/${CERT_NAME}"
if [[ ! -f "$CERT_DIR/fullchain.pem" ]]; then
  echo "certificate not found at $CERT_DIR" >&2
  exit 1
fi

install -d -m 0755 /etc/nginx/ssl
ln -sfn "$CERT_DIR/fullchain.pem" /etc/nginx/ssl/dsh-relay.pem
ln -sfn "$CERT_DIR/privkey.pem"  /etc/nginx/ssl/dsh-relay.key

install -d -m 0755 /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/dsh-reload-nginx.sh <<HOOK
#!/bin/sh
set -e
ln -sfn /etc/letsencrypt/live/${CERT_NAME}/fullchain.pem /etc/nginx/ssl/dsh-relay.pem
ln -sfn /etc/letsencrypt/live/${CERT_NAME}/privkey.pem  /etc/nginx/ssl/dsh-relay.key
nginx -t
systemctl reload nginx
HOOK
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/dsh-reload-nginx.sh

echo
openssl x509 -in "$CERT_DIR/fullchain.pem" -noout -enddate -subject -ext subjectAltName
echo
echo "certificate installed: /etc/nginx/ssl/dsh-relay.pem"
echo "renewal: rerun this script, or replace manual DNS with a provider API."
