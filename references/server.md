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
- Are 7000/7500/13080+ free?
- Is the cloud security group open for 80/443/7000?

Back up the nginx tree if it is not already versioned:

```bash
sudo tar -C /etc -czf /root/nginx-backup-$(date +%F-%H%M).tar.gz nginx
```

## 1. DNS

Add a record for the portal and one per PC. There is no fixed PC count; a wildcard A record is also valid:

```text
dsh.BASE_DOMAIN    A    SERVER_IP
pc-a.BASE_DOMAIN   A    SERVER_IP
pc-b.BASE_DOMAIN   A    SERVER_IP
pc-c.BASE_DOMAIN   A    SERVER_IP
# optional: *.BASE_DOMAIN A SERVER_IP
```

Verify from an external network, not only the server:

```bash
dig +short dsh.BASE_DOMAIN
dig +short pc-a.BASE_DOMAIN
dig +short pc-c.BASE_DOMAIN
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
allowPorts = [{ start = 13080, end = 65535 }]
webServer.addr = "127.0.0.1"
webServer.port = 7500
```

`proxyBindAddr` keeps every remote port on loopback. nginx reaches them, the public internet does not. The allocator starts at 13080; the upper bound is the OS port space, not a hardcoded PC count.

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
- creates `/etc/nginx/dsh-pcs/` for generated per-PC blocks and includes
  `/etc/nginx/dsh-pcs/*.conf` from the site config;
- copies `templates/portal/` to `/srv/dsh-portal`, preserving an existing
  `pcs.json` registry;
- creates `/etc/nginx/.htpasswd-dsh` (640, `root:www-data`);
- runs `nginx -t` and reloads nginx.

The main template contains only the portal and the shared `map`. Per-PC server blocks are generated on demand, so the site config does not change when you add PC C, D, ... N.

### Add PC C / D / ... N

```bash
sudo -E BASE_DOMAIN="$BASE_DOMAIN" \
  bash scripts/server/add-pc.sh --name pc-c --label "PC C" --desc "备用工作站"
```

`add-pc.sh`:

- validates the name as a DNS label and rejects reserved names;
- allocates the next free loopback port from `13080-65535`;
- renders `/etc/nginx/dsh-pcs/<name>.conf`;
- appends `/etc/dsh-relay/pcs.tsv`;
- updates `/srv/dsh-portal/pcs.json`;
- rolls back the config, registry, and JSON if `nginx -t` fails;
- reloads nginx and prints the Windows `New-DshClient.ps1` command with the port.

Use `--port 13082` to pin a specific port. The only practical ceiling is the number of free loopback ports; there is no `pc-a`/`pc-b` allow-list.

### Remove a PC

```bash
sudo bash scripts/server/remove-pc.sh --name pc-c
```

This removes `/etc/nginx/dsh-pcs/pc-c.conf`, the `pcs.tsv` row, and the `pcs.json` entry, then tests and reloads nginx. It does not touch the Windows PC; stop `dsh-frpc` and `dsh-web-pc-c` there separately.

Existing sites are untouched: each generated block uses an exact `server_name`, so its match beats any default server. Order matters: the certificate symlinks must exist before `nginx -t`.

If you are upgrading an older fixed `pc-a`/`pc-b` template, note that the new main config no longer contains those blocks. Recreate them with `add-pc.sh` after the upgrade; if `frps` is still holding the old port, use `--port` with a new free port and update that PC's `frpc.toml`/task.

## 5. Firewall / security group

Cloud security group:

- inbound 80/tcp, 443/tcp, 7000/tcp
- no inbound 7500, 13080-65535, or 3080

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
- `pcs.json` is the PC list read by the portal; `add-pc.sh` updates it and `install-nginx-site.sh` preserves it;
- `manifest.webmanifest` makes it installable;
- `sw.js` caches only static shell files, never `/api/*` or `pcs.json`;
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
curl -sS -o /dev/null -w 'pc-c login: %{http_code}\n' https://pc-c.BASE_DOMAIN/login
```

Expected before a PC connects: that PC may return 502. After frpc + DSH are up: `/login` 200, `/` 401 unauthenticated, `/` 200 after DSH login. `verify-deployment.sh` loops over every entry in `pcs.json`; add or remove a PC and rerun it.

Certificate trust must be checked without `-k`, for the portal and every registered PC:

```bash
BASE_DOMAIN="$BASE_DOMAIN" python3 - <<'PY'
import json
import os
import urllib.error
import urllib.request

domain = os.environ["BASE_DOMAIN"]
hosts = ["dsh"]
try:
    entries = json.load(open("/srv/dsh-portal/pcs.json", encoding="utf-8"))
    hosts += [e["id"] for e in entries if isinstance(e, dict) and e.get("id")]
except Exception:
    pass

for host in hosts:
    url = f"https://{host}.{domain}/"
    try:
        urllib.request.urlopen(url, timeout=15)
    except urllib.error.HTTPError as e:
        print(host, e.code, "TLS OK")
PY
```

`HTTPError` still means TLS succeeded. A certificate for `*.BASE_DOMAIN` covers every one-level PC name; it does not cover the apex.

## 8. Upgrades and rollback

- Keep a timestamped backup of `/etc/nginx`, `/etc/frp`, `/etc/letsencrypt`.
- Upgrade frps and frpc together; check the release notes for TOML changes.
- To roll back nginx: restore the backup or remove the `sites-enabled/dsh-relay.conf` symlink, `nginx -t`, reload.
- To roll back frps: `systemctl disable --now frps`.
- Do not delete DNS records immediately; cached PWA links and certificates may still reference them.
