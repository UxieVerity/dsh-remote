---
name: dsh-remote
description: "Deploy and operate a self-hosted L1 remote-access stack for DSH Web: frp TCP tunnel, nginx TLS reverse proxy, PWA portal, and per-PC DSH login on Ubuntu and Windows. Use for phone access to DSH, frp relay, or a DSH PWA portal."
---

# DSH Remote (L1) deployment

Use this skill when the user wants to reach one or more DSH Web instances from a phone or another network, or asks for a self-hosted frp/nginx/PWA relay.

The target is an **L1 page-level relay**: the phone opens each PC's real DSH Web UI through nginx + frp. Do not invent a custom DSH message protocol, and do not iframe the DSH UI.

## Hard rules

1. **Never write real deployment values into this repository.** Domains, public IPs, frp tokens, portal passwords, DSH passwords, SSH credentials, and certificate material belong in `deploy.local/` (ignored) or a password manager.
2. **Do not disturb an existing website.** Inspect `nginx -T`, existing `server_name` blocks, and the default server before adding a site. Back up any file you replace.
3. **Only 80/443/7000 are public.** `7500` (frps dashboard), `13080-13099` (frp remote ports), and `3080` (DSH) must stay on loopback.
4. **Preserve `Host`.** The nginx proxy must send `proxy_set_header Host $host;`. Without it the stock Host trust fence can reject requests and the login flow can see the wrong authority.
5. **Use DNS-01 for the wildcard certificate.** Some mainland-China clouds return an ICP block on port 80 for new subdomains before nginx is reached, so HTTP-01 can fail even when DNS and nginx are correct.
6. **Do not log DSH launch tokens.** DSH prints a one-time token on stdout; redirect stdout to nul when running it as a background task, and keep only stderr for diagnostics.
7. **Use the hidden frpc wrapper.** Directly scheduling `frpc.exe` opens a black console window; closing it kills the tunnel. Run it through `wscript.exe` + `start-frpc-hidden.vbs`.
8. **Secrets never go into shell history or commit messages.** Generate them with `openssl rand`, pass them via an env file or prompt, and `chmod 600` the resulting config.

## Inputs to collect

Fill these before running anything. Use placeholders until the user provides values.
If a mandatory value is missing, ask for it; do not invent a domain, IP, or password.

| Variable | Meaning | Example placeholder |
|---|---|---|
| `BASE_DOMAIN` | Domain suffix | `example.com` |
| `SERVER_IP` | Public IPv4 of the relay | `<SERVER_IP>` |
| `PORTAL_HOST` | Portal hostname | `dsh.${BASE_DOMAIN}` |
| `PC_A_HOST` | PC A hostname | `pc-a.${BASE_DOMAIN}` |
| `PC_B_HOST` | PC B hostname | `pc-b.${BASE_DOMAIN}` |
| `FRP_TOKEN` | 64-hex shared token | `<generated>` |
| `PORTAL_USER` / `PORTAL_PASSWORD` | Portal basic auth | `<generated>` |
| `DASHBOARD_PASSWORD` | frps dashboard password | `<generated>` |
| `DSH_ADMIN_USER` / `DSH_ADMIN_PASSWORD` | Per-PC DSH login | `<user-set>` |
| `FRP_VERSION` | frp release | `0.71.1` |

Port conventions:

- `7000/tcp`: frps control, public.
- `7500/tcp`: frps dashboard, loopback only.
- `13080/tcp`: PC A remote port, loopback only.
- `13081/tcp`: PC B remote port, loopback only.
- `3080/tcp`: DSH Web on each PC, loopback only.

## Architecture in one minute

```text
phone -> https://dsh.BASE_DOMAIN  -> nginx portal (basic auth)
      -> https://pc-a.BASE_DOMAIN -> nginx -> 127.0.0.1:13080 -> frps -> frpc on PC A -> 127.0.0.1:3080
```

- `frps` and `frpc` carry raw TCP; nginx terminates TLS and adds the portal.
- The certificate is a wildcard `*.BASE_DOMAIN`, so `dsh`, `pc-a`, and `pc-b` share it. The apex/`www` keeps its existing certificate.
- DSH's own username/password plugin is a second, independent auth layer. Portal basic auth is not the DSH password.
- The server can read plaintext between nginx and DSH; state this explicitly in the security notes.

## Workflow

### Phase 0 - Recon and safety

- Confirm the server OS, architecture, available RAM/disk, and whether nginx/Caddy already owns 80/443.
- Confirm the user has DNS control and cloud security-group access.
- Run `ss -lntp`, `nginx -T`, `systemctl --no-pager status nginx`, and `df -h`.
- Back up existing nginx config and certificates before editing.
- Verify that the chosen hostnames do not already resolve to a different service.

### Phase 1 - DNS and TLS

1. Add A records for `dsh`, `pc-a`, and `pc-b` to `SERVER_IP`. TTL 300 is convenient during setup.
2. Do **not** put the relay behind an HTTP CDN proxy. frpc uses TCP 7000, which an HTTP proxy does not carry.
3. Issue a wildcard certificate with DNS-01:

   ```bash
   sudo -E BASE_DOMAIN=example.com ACME_EMAIL=you@example.com \
     bash scripts/server/issue-wildcard-cert.sh
   ```

   Add the TXT record at `_acme-challenge.BASE_DOMAIN` when certbot prompts, wait for propagation, then continue.
4. The script disables `certbot.timer` because the manual DNS hook cannot renew unattended. Record the expiry and either renew manually or move to a DNS-provider API before it expires.
5. Install the certificate symlinks at `/etc/nginx/ssl/dsh-relay.pem` and `.key` (the script does this).

If the provider blocks port 80, do not waste time debugging HTTP-01; use DNS-01.

### Phase 2 - frps on Ubuntu

```bash
sudo -E FRP_VERSION=0.71.1 \
  FRP_TOKEN='<64-hex>' DASHBOARD_PASSWORD='<strong>' \
  bash scripts/server/install-frps.sh
```

The script:

- installs `/usr/local/bin/frps` and `/etc/frp/frps.toml` (mode 640, group `frp`);
- creates a `frp` system user;
- enables and starts `frps.service`;
- keeps `proxyBindAddr` and the dashboard on loopback.

Verify:

```bash
systemctl is-enabled frps && systemctl is-active frps
ss -lntp | grep -E ':(7000|7500)\b'
frps verify -c /etc/frp/frps.toml
```

### Phase 3 - nginx + PWA portal

```bash
sudo -E BASE_DOMAIN=example.com \
  PORTAL_USER=admin PORTAL_PASSWORD='<strong>' \
  bash scripts/server/install-nginx-site.sh
```

This renders `templates/nginx-dsh-relay.conf.template`, copies `templates/portal/` to `/srv/dsh-portal`, creates `/etc/nginx/.htpasswd-dsh`, tests nginx, and reloads it.

Important nginx details are already in the template:

- `map $http_upgrade $dsh_connection_upgrade` in the `http` context;
- `proxy_http_version 1.1`, `Upgrade`, and `Connection` for DSH WebSockets;
- `proxy_set_header Host $host;`
- long proxy read timeouts and `proxy_buffering off`;
- HSTS and TLS 1.2/1.3;
- portal `auth_basic`, manifest MIME, and no-cache `sw.js`.

The portal is intentionally **not** an iframe. It links to `https://pc-a...` and `https://pc-b...` in a new page/PWA window.

### Phase 4 - Windows PC

On each PC, as the Windows user that owns DSH:

```powershell
# 1. Download frpc 0.71.1 (match frps) and place frpc.exe in C:\dsh-relay.
# 2. Install the remote-login plugin.
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-dsh-plugin.ps1

# 3. Generate frpc.toml + start-dsh-web.cmd from templates.
powershell -ExecutionPolicy Bypass -File .\scripts\windows\New-DshClient.ps1 `
  -PcName pc-a -BaseDomain example.com -ServerIp <SERVER_IP> `
  -FrpToken '<64-hex>' -RemotePort 13080

# 4. Test DSH Web locally first.
C:\dsh-relay\start-dsh-web.cmd

# 5. Register hidden frpc + DSH Web tasks (current user logon, no admin).
powershell -ExecutionPolicy Bypass -File C:\dsh-relay\register-pc-tasks.ps1 -PcName pc-a
```

The `register-pc-tasks.ps1` script uses:

```text
wscript.exe //B //Nologo C:\dsh-relay\start-frpc-hidden.vbs
```

so there is **no black console window**. The VBS waits for frpc and restarts it every 10 seconds if it exits.

`run-dsh-web.cmd` suppresses stdout (which contains the DSH launch token) and keeps the task alive while port 3080 exists, so Task Scheduler can restart DSH if it dies.

### Phase 5 - End-to-end verification

```bash
sudo -E BASE_DOMAIN=example.com PORTAL_USER=admin PORTAL_PASSWORD='<strong>' \
  bash scripts/server/verify-deployment.sh
```

Expected:

| URL | Expected |
|---|---|
| `https://dsh.BASE_DOMAIN/` without auth | `401` |
| `https://dsh.BASE_DOMAIN/` with portal auth | `200` |
| `https://pc-a.BASE_DOMAIN/login` | `200` |
| `https://pc-a.BASE_DOMAIN/` without DSH session | `401` |
| `https://pc-a.BASE_DOMAIN/` after DSH login | `200` |
| `https://www.BASE_DOMAIN/` | existing site still `200` |

On Windows, also verify:

```powershell
Get-ScheduledTask -TaskName dsh-frpc,dsh-web-pc-a | Get-ScheduledTaskInfo
Get-Process frpc,wscript | Select-Object Id,ProcessName,MainWindowHandle
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

`MainWindowHandle` must be `0`; the frpc task must be `Running`.

### Phase 6 - Handoff

- Put all generated secrets in one local, ignored credentials file; tell the user where it is and that it is sensitive.
- Tell the user there are **two passwords**: portal basic auth and DSH login.
- Document that both Windows tasks start at **user logon**. A reboot with no login leaves the PC unreachable; DSH cannot run in a pre-login session. For frpc-at-boot, use the optional SYSTEM task, but DSH still needs a logged-in desktop session.
- Record certificate expiry and the renewal method.
- Provide stop/rollback commands.

## Validation gates

Do not call the deployment complete until all are true:

- [ ] `frps` enabled and active; 7000 reachable from outside, 7500 loopback only.
- [ ] `nginx -t` passes; existing site still returns 200.
- [ ] Wildcard certificate is trusted by a normal HTTPS client (not just `curl -k`).
- [ ] Portal returns 401/200; `manifest.webmanifest` and `sw.js` return 200.
- [ ] PC `/login` returns 200, `/` returns 401 unauthenticated, `/` returns 200 after DSH login.
- [ ] `frpc` is running with `MainWindowHandle = 0`; no black console.
- [ ] Killing frpc causes automatic restart within ~15 seconds.
- [ ] After login/reboot, tasks start automatically.
- [ ] No real domain/IP/token/password is present in git.

## Rollback

- Disable the new nginx site symlink and reload nginx; restore the backup if needed.
- Stop/disable `frps`.
- Stop/disable `dsh-frpc` and `dsh-web-pc-a`.
- Remove `/etc/nginx/ssl/dsh-relay.*` only if you are sure no other site uses it.
- Leave DNS/certificate records until the user confirms; removing them breaks PWA installs and cached links.

## References

Read these before editing a live host:

- `references/architecture.md` - data flow, trust boundaries, why L1.
- `references/variables.md` - variable/secret handling and placeholders.
- `references/server.md` - full Ubuntu walkthrough and commands.
- `references/windows.md` - full Windows walkthrough, hidden tasks, logon caveats.
- `references/security.md` - threat model and hardening checklist.
- `references/troubleshooting.md` - 502/401/403, cert, WebSocket, task and token issues.
