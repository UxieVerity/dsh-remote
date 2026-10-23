# Variables and secret handling

Use placeholders until the user supplies values. Put real values only in `deploy.local/`, which is ignored by git.

## Required values

| Variable | Used by | Notes |
|---|---|---|
| `BASE_DOMAIN` | DNS, nginx, portal, DSH flags | e.g. `example.com`; do not use a real domain in this repo |
| `SERVER_IP` | DNS, frpc | Public IPv4 of the relay |
| `FRP_VERSION` | server + client | Keep frps/frpc on the same minor release; `0.71.1` is the tested baseline |
| `FRP_TOKEN` | frps + frpc | 64 hex chars; generate with `openssl rand -hex 32` |
| `DASHBOARD_PASSWORD` | frps | Dashboard is loopback-only, but still set a strong value |
| `PORTAL_USER` | nginx basic auth | Can be `admin`; not a secret by itself |
| `PORTAL_PASSWORD` | nginx basic auth | Generate with `openssl rand -base64 24` |
| `DSH_ADMIN_USER` | DSH login | Set on first `/login` visit, or via a password manager |
| `DSH_ADMIN_PASSWORD` | DSH login | Never store in the repo; not the same as the portal password |
| `ACME_EMAIL` | Let's Encrypt | Use a real mailbox you control |

## Ports

| Port | Bind | Public | Purpose |
|---|---|---|---|
| 80 | nginx | yes | ACME HTTP + redirect; may be ICP-blocked for new subdomains |
| 443 | nginx | yes | TLS portal + PC reverse proxy |
| 7000 | frps | yes | frpc control/data |
| 7500 | frps | no | dashboard, `127.0.0.1` |
| 13080-13099 | frps | no | remote ports, `127.0.0.1` |
| 3080 | DSH | no | each PC, `127.0.0.1` |

## Generate values

Linux/macOS:

```bash
FRP_TOKEN="$(openssl rand -hex 32)"
PORTAL_PASSWORD="$(openssl rand -base64 24)"
DASHBOARD_PASSWORD="$(openssl rand -base64 24)"
```

PowerShell:

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$FRP_TOKEN = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
```

## Local env file

Create `deploy.local/env` (ignored) and source it on the server:

```bash
mkdir -p deploy.local
chmod 700 deploy.local
cat > deploy.local/env <<'EOF'
export BASE_DOMAIN="example.com"
export SERVER_IP="<SERVER_IP>"
export FRP_VERSION="0.71.1"
export FRP_TOKEN="REPLACE_WITH_64_HEX"
export DASHBOARD_PASSWORD="REPLACE_WITH_STRONG_PASSWORD"
export PORTAL_USER="admin"
export PORTAL_PASSWORD="REPLACE_WITH_STRONG_PASSWORD"
export ACME_EMAIL="you@example.com"
EOF
chmod 600 deploy.local/env
```

`<SERVER_IP>` is a placeholder. Replace it only in the ignored local file.

## Secrets at rest

- `/etc/frp/frps.toml`: mode 640, owner `root`, group `frp`.
- `/etc/nginx/.htpasswd-dsh`: mode 640, owner `root`, group `www-data`.
- `C:\dsh-relay\frpc.toml`: contains the frp token; restrict ACL to the owning user.
- `C:\dsh-relay` logs: no DSH launch tokens; only frpc logs and DSH stderr.
- Credentials handoff file: mode 600 on Linux, user-only ACL on Windows; never email it in plain text.

## Never commit

- Real domains or public IPs.
- `frpc.toml` / `frps.toml` generated from templates.
- `.pem`, `.key`, `.p12`, `.pfx`.
- Portal password files.
- `deploy.local/` or `credentials*`.
- DSH `web-auth.json` or session databases.
