# Ubuntu server deployment

This is the reference path for Ubuntu 22.04/24.04 with nginx. It assumes root or sudo.

## 0. Recon before touching anything

```bash
uname -a
cat /etc/os-release
df -h
free -h
ss -lntp
nginx -T 2>/dev/null | grep -E 'server_name|listen' | head -80
systemctl --no-pager status nginx
```

Answer these before adding the relay:

- Does nginx already own 80/443?
- Which `server_name`s and default server exist?
- Is `frps` already installed?
- Are 7000/7500/13080/13081 free?
- Is the cloud security group open for 80/443/7000?

Back up the nginx tree if it is not already versioned:

```bash
sudo tar -C /etc -czf /root/nginx-backup-$(date +%F-%H%M).tar.gz nginx
```

## 1. DNS

Add:

```text
dsh.BASE_DOMAIN    A    SERVER_IP
pc-a.BASE_DOMAIN   A    SERVER_IP
pc-b.BASE_DOMAIN   A    SERVER_IP
# optional: frp.BASE_DOMAIN A SERVER_IP
```

Verify from an external network, not only the server:

```bash
dig +short dsh.BASE_DOMAIN
dig +short pc-a.BASE_DOMAIN
dig +short pc-b.BASE_DOMAIN
```

Do not put the relay behind an HTTP-only CDN proxy: frpc needs raw TCP 7000.

## 2. frps

```bash
cd dsh-remote
export BASE_DOMAIN=example.com
export SERVER_IP="<SERVER_IP>"
export FRP_VERSION=0.71.1
export FRP_TOKEN="$(openssl rand -hex 32)"
export DASHBOARD_PASSWORD="$(openssl rand -base64 24)"

sudo -E FRP_VERSION="$FRP_VERSION" FRP_TOKEN="$FRP_TOKEN" \
  DASHBOARD_PASSWORD="$DASHBOARD_PASSWORD" \
  bash scripts/server/install-frps.sh
```

What it creates:

- `/usr/local/bin/frps`
- `/etc/frp/frps.toml` (640, `root:frp`)
- `/var/log/frps.log` (owned by `frp`)
- `frps.service`, enabled at boot

Critical config:

```toml
bindAddr = "0.0.0.0"
bindPort = 7000
proxyBindAddr = "127.0.0.1"
allowPorts = [{ start = 13080, end = 13099 }]
webServer.addr = "127.0.0.1"
webServer.port = 7500
```

`proxyBindAddr` is what keeps `13080/13081` off the public interface. nginx reaches them over loopback.

Verify:

```bash
systemctl is-enabled frps
systemctl is-active frps
ss -lntp | grep -E ':(7000|7500)\b'
frps verify -c /etc/frp/frps.toml
```

From an external machine:

```bash
nc -vz SERVER_IP 7000
```

If 7000 is closed, fix the cloud security group before debugging frp.

Dashboard access (loopback only):

```bash
ssh -L 7500:127.0.0.1:7500 user@SERVER_IP
# then open http://127.0.0.1:7500
```

## 3. TLS: wildcard via DNS-01

Install certbot if needed:

```bash
sudo apt update
sudo apt install -y certbot
```

Run the helper:

```bash
sudo -E BASE_DOMAIN="$BASE_DOMAIN" ACME_EMAIL="$ACME_EMAIL" \
  bash scripts/server/issue-wildcard-cert.sh
```

The helper runs roughly:

```bash
certbot certonly --manual --preferred-challenges dns \
  --cert-name dsh-wildcard \
  -d "*.${BASE_DOMAIN}" \
  --agree-tos --email "$ACME_EMAIL" --no-eff-email
```

When prompted, add a TXT record at `_acme-challenge.BASE_DOMAIN` with the value certbot prints. Wait for DNS propagation, then press Enter. Do not use `--manual` with an unattended timer: it will block forever.

The helper also:

- creates `/etc/nginx/ssl/dsh-relay.pem` and `.key` symlinks;
- installs `/etc/letsencrypt/renewal-hooks/deploy/dsh-reload-nginx.sh`;
- disables `certbot.timer` because the manual DNS challenge cannot renew unattended.

Why DNS-01: some cloud providers return an ICP/registration block on port 80 for new subdomains before the request reaches nginx. That makes HTTP-01 look like an nginx bug when it is not. HTTPS on 443 is unaffected.

### Renewal

The certificate is valid ~90 days. Record the expiry:

```bash
openssl x509 -in /etc/letsencrypt/live/dsh-wildcard/fullchain.pem \
  -noout -enddate -subject -ext subjectAltName
```

Options:

1. **Manual:** rerun the certbot command, add the new TXT, then `systemctl reload nginx`.
2. **Automated:** use a DNS-provider API plugin (`dns_ali`, `dns_cloudflare`, etc.) with a scoped API token, or use `acme.sh --dns`.

Do not re-enable `certbot.timer` until the authenticator is non-interactive.

## 4. nginx and portal

```bash
sudo -E BASE_DOMAIN="$BASE_DOMAIN" \
  PORTAL_USER="$PORTAL_USER" PORTAL_PASSWORD="$PORTAL_PASSWORD" \
  bash scripts/server/install-nginx-site.sh
```

The script:

- renders `templates/nginx-dsh-relay.conf.template` to
  `/etc/nginx/sites-available/dsh-relay.conf`;
- enables it with a symlink in `sites-enabled`;
- copies `templates/portal/` to `/srv/dsh-portal`;
- creates `/etc/nginx/.htpasswd-dsh` (640, `root:www-data`);
- runs `nginx -t` and reloads nginx.

The template has three HTTP server blocks (ACME + redirect) and three HTTPS blocks (portal + PC A + PC B). Existing sites are untouched; exact `server_name` matches take precedence.

Order matters: the certificate symlinks must exist before `nginx -t`, otherwise nginx fails to start/reload.

## 5. Firewall / security group

Cloud security group:

- inbound 80/tcp, 443/tcp, 7000/tcp
- no inbound 7500, 13080-13099, or 3080

Host firewall, if enabled:

```bash
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 7000/tcp
sudo ufw status
```

If 7000 can be restricted to the PCs' egress IPs, do it. Otherwise keep a long random token and consider fail2ban/rate limiting.

## 6. Portal

The portal is static HTML/JS in `/srv/dsh-portal`:

- `index.html` has `__BASE_DOMAIN__` replaced at install time;
- `manifest.webmanifest` makes it installable;
- `sw.js` caches only static shell files, never `/api/*`;
- `robots.txt` disallows crawling.

Basic auth is enforced by nginx, not JavaScript.

## 7. Verify

```bash
sudo -E BASE_DOMAIN="$BASE_DOMAIN" PORTAL_USER="$PORTAL_USER" \
  PORTAL_PASSWORD="$PORTAL_PASSWORD" \
  bash scripts/server/verify-deployment.sh
```

Manual checks:

```bash
curl -sS -o /dev/null -w 'portal no auth: %{http_code}\n' https://dsh.BASE_DOMAIN/
curl -sS -u "$PORTAL_USER:$PORTAL_PASSWORD" -o /dev/null -w 'portal auth: %{http_code}\n' https://dsh.BASE_DOMAIN/
curl -sS -o /dev/null -w 'pc-a login: %{http_code}\n' https://pc-a.BASE_DOMAIN/login
curl -sS -o /dev/null -w 'pc-a root: %{http_code}\n' https://pc-a.BASE_DOMAIN/
```

Expected before the PC connects: `pc-a` may return 502. After frpc + DSH are up: `/login` 200, `/` 401 unauthenticated, `/` 200 after DSH login.

Certificate trust must be checked without `-k`:

```bash
BASE_DOMAIN="$BASE_DOMAIN" python3 - <<'PY'
import os
import urllib.error
import urllib.request
domain = os.environ["BASE_DOMAIN"]
for host in ("dsh", "pc-a", "pc-b"):
    url = f"https://{host}.{domain}/"
    try:
        urllib.request.urlopen(url, timeout=15)
    except urllib.error.HTTPError as e:
        print(host, e.code, "TLS OK")
PY
```

(Replace `BASE_DOMAIN`; `HTTPError` still means TLS succeeded.)

## 8. Upgrades and rollback

- Keep a timestamped backup of `/etc/nginx`, `/etc/frp`, `/etc/letsencrypt`.
- Upgrade frps and frpc together; check the release notes for TOML changes.
- To roll back nginx: restore the backup or remove the `sites-enabled/dsh-relay.conf` symlink, `nginx -t`, reload.
- To roll back frps: `systemctl disable --now frps`.
- Do not delete DNS records immediately; cached PWA links and certificates may still reference them.
