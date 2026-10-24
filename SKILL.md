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
3. **Only 80/443/7000 are public.** `7500` (frps dashboard), `13080-65535` (frp remote ports), and `3080` (DSH) must stay on loopback.
4. **Preserve `Host`.** The nginx proxy must send `proxy_set_header Host $host;`. Without it the stock Host trust fence can reject requests and the login flow can see the wrong authority.
5. **Use DNS-01 for the wildcard certificate.** Some mainland-China clouds return an ICP block on port 80 for new subdomains before nginx is reached, so HTTP-01 can fail even when DNS and nginx are correct.
6. **Do not log DSH launch tokens.** DSH prints a one-time token on stdout; redirect stdout to nul when running it as a background task, and keep only stderr for diagnostics.
7. **Prefer the `dsh-remote` plugin for the tunnel.** The plugin in this repo's `plugin/` runs frpc as a
   `windowsHide` child of DSH, restarts it with backoff, and stops it with DSH — no VBS, no scheduled
   task, no black window. Only when the plugin cannot be installed, fall back to `wscript.exe` +
   `start-frpc-hidden.vbs`; never schedule `frpc.exe` directly (black console, and closing it kills the tunnel).
8. **Never run two frpc for one PC.** The plugin and the legacy `dsh-frpc` task claim the same
   `remotePort`; when switching to the plugin, stop and unregister `dsh-frpc` first.
9. **Secrets never go into shell history or commit messages.**

## Inputs to collect

Fill these before running anything. Use placeholders until the user provides values.
If a mandatory value is missing, ask for it; do not invent a domain, IP, or password.

| Variable | Meaning | Example placeholder |
|---|---|---|
| `BASE_DOMAIN` | Domain suffix | `example.com` |
| `SERVER_IP` | Public IPv4 of the relay | `<SERVER_IP>` |
| `PORTAL_HOST` | Portal hostname | `dsh.${BASE_DOMAIN}` |
| `PC_NAMES` | One DNS label per PC, any count | `pc-a`, `pc-b`, `pc-c` |
| `PORT_BASE` | First remote port (allocator) | `13080` |
| `FRP_TOKEN` | 64-hex shared token | `<generated>` |
| `PORTAL_USER` / `PORTAL_PASSWORD` | Portal basic auth | `<generated>` |
| `DASHBOARD_PASSWORD` | frps dashboard password | `<generated>` |
| `DSH_ADMIN_USER` / `DSH_ADMIN_PASSWORD` | Per-PC DSH login | `<user-set>` |
| `FRP_VERSION` | frp release | `0.71.1` |

Port conventions:

- `7000/tcp`: frps control, public.
- `7500/tcp`: frps dashboard, loopback only.
- `13080-65535/tcp`: per-PC remote ports, loopback only, allocated by `add-pc.sh`.
- `3080/tcp`: DSH Web on each PC, loopback only.

## Architecture in one minute

```text
phone -> https://dsh.BASE_DOMAIN  -> nginx portal (basic auth)
      -> https://<pc-name>.BASE_DOMAIN -> nginx -> 127.0.0.1:<port> -> frps -> frpc on that PC -> 127.0.0.1:3080
```

One generated block per PC; add PC C, D, ... N without editing the main site file.

- `frps` and `frpc` carry raw TCP; nginx terminates TLS and adds the portal.
- The certificate is a wildcard `*.BASE_DOMAIN`, so `dsh`, `pc-a`, `pc-b`, `pc-c`, ... share it. The apex/`www` keeps its existing certificate.
- The DSH username/password plugin is a separate auth layer from the portal. Portal basic auth is not the DSH password, and it does not gate the PC subdomains.
- The server can read plaintext between nginx and DSH; state this explicitly in the security notes.

## Workflow

### Phase 0 - Recon and safety

- Confirm the server OS, architecture, available RAM/disk, and whether nginx/Caddy already owns 80/443.
- Confirm the user has DNS control and cloud security-group access.
- Run `ss -lntp`, `nginx -T`, `systemctl --no-pager status nginx`, and `df -h`.
- Back up existing nginx config and certificates before editing.
- Verify that the chosen hostnames do not already resolve to a different service.

### Phase 1 - DNS and TLS

1. Add A records for `dsh` and each PC name to `SERVER_IP`; a wildcard `*.BASE_DOMAIN` record also works. TTL 300 is convenient during setup.
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

This installs the portal shell and the `/etc/nginx/dsh-pcs/` include directory. It does not bake PC A/B into the config. Add each PC explicitly:

```bash
sudo -E BASE_DOMAIN=example.com \
  bash scripts/server/add-pc.sh --name pc-a --label "PC A" --desc "主工作站"
# repeat with pc-b, pc-c, ... any number of unique names
```

`add-pc.sh` allocates the next free loopback port (`13080-65535`), writes `/etc/nginx/dsh-pcs/<name>.conf`, updates `/etc/dsh-relay/pcs.tsv` and `/srv/dsh-portal/pcs.json`, rolls back on `nginx -t` failure, and reloads nginx. Use `--port` to pin a port. The portal reads `pcs.json`; the main site file is never edited per PC.

Important nginx details are already in the templates:

- `map $http_upgrade $dsh_connection_upgrade` in the `http` context;
- `proxy_http_version 1.1`, `Upgrade`, and `Connection` for DSH WebSockets;
- `proxy_set_header Host $host;`
- long proxy read timeouts and `proxy_buffering off`;
- HSTS and TLS 1.2/1.3;
- portal `auth_basic`, manifest MIME, and no-cache `sw.js`/`pcs.json`.

The portal is intentionally **not** an iframe. It lists every registered PC and also accepts any valid name in its "直接输入电脑名" field, so a PC can be opened without editing HTML.

### Phase 4 - Windows PC

On each PC, as the Windows user that owns DSH. Two ways to hold the tunnel; **A is the default**,
B is the fallback for hosts where the plugin cannot be installed.

#### A. The `dsh-remote` plugin (recommended)

The plugin owns the tunnel: it renders `frpc.toml` from config, runs frpc as a hidden child of DSH,
restarts it with exponential backoff (and *stops* retrying on auth/port errors), starts with DSH and
exits with DSH, and provides `dsh_remote_status` / `dsh_remote_control` / `dsh_remote_configure`
plus loopback-only `/api/dsh-remote/*` routes.

```powershell
# 1. frpc 0.71.1 (match frps) into the directory the plugin searches first.
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\dsh-remote\bin" | Out-Null
# extract frp_0.71.1_windows_amd64.zip -> frpc.exe in that bin directory
& "$env:USERPROFILE\.dsh\dsh-remote\bin\frpc.exe" -v

# 2. The remote-login plugin (unchanged: DSH needs auth for remote clients).
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-dsh-plugin.ps1

# 3. Install this repo's tunnel plugin into the web profile.
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile web add "D:\path\to\dsh-remote\plugin"

# 4. Restart DSH (bundle layers are assembled at startup).
```

Then configure it from inside DSH — via **Settings → 远程接入** (the plugin's own page), by telling the
agent ("configure the tunnel: pc-a, example.com, <SERVER_IP>, remotePort 13080, token ..."), or by calling
the tool directly. The page is loopback-only: it refuses requests whose Host is the public domain, so the
tunnel config can only be changed on the PC itself. Config lives in
`$DSH_HOME\dsh-remote\config.json` (mode 0600), **not** in the profile yml, so the token never enters
profile configuration.

Switch off the legacy task if it was registered before:

```powershell
Stop-ScheduledTask dsh-frpc -ErrorAction SilentlyContinue
Unregister-ScheduledTask dsh-frpc -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
```

You still start DSH with the trust flags. The plugin reports when they are missing: it probes the Host
fence with the public authority and distinguishes 403 (fence) from 502 (tunnel up, DSH down).

```text
--host 127.0.0.1 --port 3080
--trusted-host pc-a.BASE_DOMAIN --trusted-host pc-a.BASE_DOMAIN:443
--public-url https://pc-a.BASE_DOMAIN/
```

**Desktop (Electron) app instead of a terminal `dsh web`?** Two things differ, and both have
bitten real deployments:

- The web port is chosen at runtime and changes every launch, so nothing may hard-code it.
  (The plugin re-detects its own listening port, rewrites the render, restarts frpc if needed.)
- There is **no `--trusted-host` to pass**. The Host fence then refuses every `/api/*` call from the
  public domain name — pages and login still work — and the UI sits on "重新连接中" forever. Satisfy it in
  the profile instead, in `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`:

  ```yaml
  - id: connection
    name: "@deepseek-ai/dsh-client-connection"
    config:
      trustedHosts: !!js "['pc-a.BASE_DOMAIN', ...(ctx.webStartup?.trustedHosts ?? [])]"
  ```

  Bare `host[:port]` only; a malformed entry makes the profile fail to load. The loader hot-reloads the
  file, so saving it is enough. Proof in `/var/log/nginx/access.log`: the same `/api/*` paths flip
  `403` -> `200`.

Only `dsh-web-<name>` stays a scheduled task (it starts DSH; the plugin follows DSH):

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-relay\register-pc-tasks.ps1 -PcName pc-a
# then stop/unregister dsh-frpc as above — the plugin already holds the tunnel
```

#### B. Scripts (fallback)

```powershell
# 1. Download frpc 0.71.1 (match frps) and place frpc.exe in C:\dsh-relay.
# 2. Install the remote-login plugin.
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-dsh-plugin.ps1

# 3. Generate frpc.toml + start-dsh-web.cmd from templates.
#    Use the port printed by add-pc.sh for this PC (13080 is only an example).
powershell -ExecutionPolicy Bypass -File .\scripts\windows\New-DshClient.ps1 `
  -PcName pc-a -BaseDomain example.com -ServerIp <SERVER_IP> `
  -FrpToken '<64-hex>' -RemotePort 13080

# 4. Test DSH Web locally first.
C:\dsh-relay\start-dsh-web.cmd

# 5. Register hidden frpc + DSH Web tasks (current user logon, no admin).
powershell -ExecutionPolicy Bypass -File C:\dsh-relay\register-pc-tasks.ps1 -PcName pc-a
```

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
| `https://<pc-name>.BASE_DOMAIN/login` for every registered PC | `200` |
| `https://<pc-name>.BASE_DOMAIN/` without DSH session | `401` |
| `https://<pc-name>.BASE_DOMAIN/` after DSH login | `200` |
| `https://www.BASE_DOMAIN/` | existing site still `200` |

`verify-deployment.sh` reads `/srv/dsh-portal/pcs.json`, so it checks every PC, not a hardcoded pair.

On Windows, also verify. With the plugin (path A):

```powershell
# In DSH: "check the remote-access status" -> dsh_remote_status, or:
Invoke-RestMethod "http://127.0.0.1:3080/api/dsh-remote/status?deep=1" | ConvertTo-Json -Depth 6
```

Expected: `configured = true`, `tunnel.state = "connected"`, `health.level = "ok"`, and
`health.missingTrustedHosts` empty (or only the informational `:443` variant). No `frpc` console
window exists because frpc is a `windowsHide` child of DSH.

With the scripts (path B):

```powershell
Get-ScheduledTask -TaskName dsh-frpc,dsh-web-<pc-name> | Get-ScheduledTaskInfo
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
- [ ] Portal returns 401/200; `manifest.webmanifest`, `sw.js`, and `pcs.json` return 200.
- [ ] Every PC in `pcs.json` has `/login` 200, `/` 401 unauthenticated, `/` 200 after DSH login.
- [ ] Adding a new PC with `add-pc.sh` passes `nginx -t`, appears in the portal, and gets a unique port.
- [ ] Exactly one frpc serves each PC: either the plugin or the `dsh-frpc` task, never both.
- [ ] Plugin path: `dsh_remote_status` shows `configured: true`, `tunnel.state: "connected"`,
      `health.fence: "passed"`, and no console window appears for frpc.
- [ ] Plugin path: killing frpc (Task Manager) makes the plugin re-spawn it within ~60s; a token
      mismatch leaves it in `auth-error` and does **not** loop forever.
- [ ] Script path: `frpc` is running with `MainWindowHandle = 0`; no black console.
- [ ] Killing frpc causes automatic restart within ~15 seconds.
- [ ] After login/reboot, the tunnel comes up automatically (plugin follows DSH; `dsh-web-<name>` starts DSH).
- [ ] No real domain/IP/token/password is present in git (`$DSH_HOME/dsh-remote/config.json` lives outside the repo).


## Rollback

- Disable the new nginx site symlink and reload nginx; restore the backup if needed.
- Stop/disable `frps`.
- Stop/disable `dsh-frpc` and every `dsh-web-<pc-name>` task. If the plugin owns the tunnel, also stop it
  (`dsh_remote_control stop`) and remove the plugin: `dsh plugin --profile web remove dsh-remote`,
  then delete `$DSH_HOME/dsh-remote/` (it holds the token) if the PC is being retired.
- Remove only the relevant `/etc/nginx/dsh-pcs/<pc-name>.conf` when removing one PC; run `nginx -t` and reload.
- Remove `/etc/nginx/ssl/dsh-relay.*` only if you are sure no other site uses it.
- Leave DNS/certificate records until the user confirms; removing them breaks PWA installs and cached links.

## References

Read these before editing a live host:

- `references/architecture.md` - data flow, trust boundaries, why L1.
- `references/variables.md` - variable/secret handling and placeholders.
- `references/server.md` - full Ubuntu walkthrough and commands.
- `references/windows.md` - full Windows walkthrough, plugin or scripts, hidden tasks, logon caveats.
- `references/security.md` - threat model and hardening checklist.
- `references/troubleshooting.md` - 502/401/403, cert, WebSocket, task and token issues.