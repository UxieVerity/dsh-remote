#!/usr/bin/env bash
# Render and install the nginx site + PWA portal. Run as root.
#
# Required env:
#   BASE_DOMAIN
#   PORTAL_PASSWORD
# Optional:
#   PORTAL_USER (default: admin)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PORTAL_SRC="$ROOT/templates/portal"
NGINX_TEMPLATE="$ROOT/templates/nginx-dsh-relay.conf.template"
PORTAL_USER="${PORTAL_USER:-admin}"

BASE_DOMAIN="${BASE_DOMAIN:-}"
PORTAL_PASSWORD="${PORTAL_PASSWORD:-}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "run as root" >&2
  exit 1
fi
if [[ -z "$BASE_DOMAIN" ]]; then
  echo "BASE_DOMAIN is required" >&2
  exit 1
fi
if [[ -z "$PORTAL_PASSWORD" ]]; then
  echo "PORTAL_PASSWORD is required" >&2
  exit 1
fi
if [[ ! -f "$NGINX_TEMPLATE" || ! -d "$PORTAL_SRC" ]]; then
  echo "templates not found under $ROOT/templates" >&2
  exit 1
fi
command -v nginx >/dev/null || { echo "nginx is required" >&2; exit 1; }
command -v htpasswd >/dev/null || { echo "htpasswd is required (apt install apache2-utils)" >&2; exit 1; }
if [[ ! -f /etc/nginx/ssl/dsh-relay.pem || ! -f /etc/nginx/ssl/dsh-relay.key ]]; then
  echo "missing /etc/nginx/ssl/dsh-relay.pem or .key" >&2
  echo "run scripts/server/issue-wildcard-cert.sh first" >&2
  exit 1
fi

install -d -m 0755 /srv/dsh-portal
install -d -m 0755 /var/www/letsencrypt
install -d -m 0755 /etc/nginx/ssl

cp -a "$PORTAL_SRC/." /srv/dsh-portal/
# Only the portal index contains the domain placeholder.
sed -i "s|__BASE_DOMAIN__|${BASE_DOMAIN}|g" /srv/dsh-portal/index.html
chown -R root:www-data /srv/dsh-portal
find /srv/dsh-portal -type d -exec chmod 0755 {} +
find /srv/dsh-portal -type f -exec chmod 0644 {} +

printf '%s\n' "$PORTAL_PASSWORD" | htpasswd -ci /etc/nginx/.htpasswd-dsh "$PORTAL_USER"
chown root:www-data /etc/nginx/.htpasswd-dsh
chmod 0640 /etc/nginx/.htpasswd-dsh

if [[ -f /etc/nginx/sites-available/dsh-relay.conf ]]; then
  install -d -m 0700 /root/dsh-relay-backup
  cp -a /etc/nginx/sites-available/dsh-relay.conf \
    "/root/dsh-relay-backup/dsh-relay.conf.$(date +%Y%m%d-%H%M%S)"
fi

sed "s|__BASE_DOMAIN__|${BASE_DOMAIN}|g" "$NGINX_TEMPLATE" \
  > /etc/nginx/sites-available/dsh-relay.conf
chmod 0644 /etc/nginx/sites-available/dsh-relay.conf
ln -sfn /etc/nginx/sites-available/dsh-relay.conf /etc/nginx/sites-enabled/dsh-relay.conf

nginx -t
systemctl reload nginx

echo
echo "portal: https://dsh.${BASE_DOMAIN}/"
echo "pc-a:   https://pc-a.${BASE_DOMAIN}/"
echo "pc-b:   https://pc-b.${BASE_DOMAIN}/"
echo "basic auth user: ${PORTAL_USER}"
