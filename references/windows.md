# Windows PC deployment

Run these steps on each PC, as the Windows user that owns the DSH installation. You do **not** need administrator rights for the per-user task path.

## 0. Prerequisites

- DSH desktop installed; CLI at:

  ```text
  %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
  ```

- Node.js and pnpm available if you need to install plugins.
- An outbound network path to `SERVER_IP:7000`.
- A local directory `C:\dsh-relay` (or another writable directory).
- The frp release matching the server. The tested baseline is `0.71.1`.

## 1. Install frpc

Download `frp_<version>_windows_amd64.zip` from the frp releases page and extract `frpc.exe`:

```powershell
New-Item -ItemType Directory -Force C:\dsh-relay | Out-Null
# Copy frpc.exe into C:\dsh-relay\frpc.exe
C:\dsh-relay\frpc.exe -v
```

Expected: `0.71.1` (or the version you chose). Keep frps and frpc on the same release.

## 2. Install the remote-login plugin

A non-loopback DSH bind requires authentication. The tested baseline uses `dsh-web-startup-auth` for username/password login and `/api/*` protection. Newer DSH builds may ship native web auth; if so, the plugin is optional, but pin it for the tested flow.

```powershell
cd C:\path\to\dsh-remote
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-dsh-plugin.ps1
```

Equivalent:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile web add dsh-web-startup-auth@0.1.13
```

If the default npm registry is an internal mirror without the package, add:

```powershell
& $dsh plugin --profile web add dsh-web-startup-auth@0.1.13 --registry https://registry.npmjs.org/
```

Version notes:

- DSH `0.2.1-rc.2` is the tested baseline.
- The plugin supports DSH `>=0.1.7-rc.1 <0.3.0`.
- If DSH is outside the supported range, DSH will skip the bundle and log the reason; do not force it.

## 2.5 Tunnel: the plugin (recommended)

> **Desktop (Electron) app, two things the terminal path does not have**
>
> - The web port is assigned at runtime and changes on every launch. Never hard-code it in
>   `frpc.toml`; the plugin re-detects it and rewrites the render (see `plugin/README.md`).
> - There is no `--trusted-host` flag to reach, so the Host fence must be satisfied in the profile:
>   add the `connection` row override with `trustedHosts: ['<name>.BASE_DOMAIN', ...]` to
>   `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`. Symptom without it: the page and login
>   work, every `/api/*` call answers 403, and the UI sits on "重新连接中". Details in
>   `references/troubleshooting.md` (403 Forbidden).

Sections 3, 5, 6, 7 and 8 are the **script** path: they render `frpc.toml`, keep frpc alive through a
VBS wrapper, and register the `dsh-frpc` task. The `dsh-remote` plugin in this repo replaces that whole
layer and is the default choice.

What moves into the plugin:

| Script path | Plugin |
|---|---|
| `New-DshClient.ps1` renders `frpc.toml` | renders it on every start, from `config.json` |
| `start-frpc-hidden.vbs` (hidden console + 10s loop) | `spawn(frpc, { windowsHide: true })`, exponential backoff |
| `dsh-frpc` scheduled task at logon | starts with DSH, exits with DSH |
| manual `Get-Process` / `curl` checks | `dsh_remote_status` and `/api/dsh-remote/status` |

Install (frpc must already be on the PC, see section 1):

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile web add "D:\path\to\dsh-remote\plugin"
# restart DSH afterwards (bundle layers are assembled at startup)
```

The plugin looks for frpc at `$DSH_HOME\dsh-remote\bin\frpc.exe` first, then `C:\dsh-relay\frpc.exe`,
then `PATH`; `frpcPath` in the config overrides all of them. Moving the binary is optional.

Configure it from inside DSH — ask the agent, or call the tool with a patch:

```text
pcName       pc-a            (must match add-pc.sh --name)
baseDomain   example.com
serverAddr   <SERVER_IP>
serverPort   7000
remotePort   13080           (the port add-pc.sh printed)
token        <64-hex>        (or put it in $DSH_HOME\dsh-remote\frp-token)
```

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/api/dsh-remote/config `
  -ContentType 'application/json' `
  -Body '{"patch":{"pcName":"pc-a","baseDomain":"example.com","serverAddr":"203.0.113.10","remotePort":13080,"token":"<64-hex>"}}'
```

Config lives in `$DSH_HOME\dsh-remote\config.json` (mode 0600), outside the profile and outside git.
The plugin reads the real port from its own process (`netstat -ano` by PID), so a desktop app that picks a
random port each launch still works; if a stray `frpc.exe` from a crashed run holds the remote port it gets
swept before spawn.
Easiest is the settings page: **Settings → 远程接入** (restart DSH once after installing). It calls the
plugin's loopback-only `/api/dsh-remote/*` routes, so it works on the PC itself, not through the tunnel.

**Migrating from the script path** — the plugin owns the tunnel now, so drop the old task, otherwise both
frpc processes fight over `remotePort`:

```powershell
Stop-ScheduledTask dsh-frpc -ErrorAction SilentlyContinue
Unregister-ScheduledTask dsh-frpc -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
```

Keep `dsh-web-<name>` if you want DSH to start at logon (section 6 registers it; section 8's SYSTEM
variant also only makes sense for the DSH task).

Verify:

```powershell
Invoke-RestMethod "http://127.0.0.1:3080/api/dsh-remote/status?deep=1" | ConvertTo-Json -Depth 6
```

frpc writes to stdout under the plugin, so its log lines appear in `tunnel.log` inside the status
response (last 300 lines, in memory) rather than in a `frpc.log` file.

Read the result like this:

| Field | Healthy | If not |
|---|---|---|
| `configured` | `true` | `issues[]` names the missing/invalid field |
| `tunnel.state` | `connected` | `bin-missing` → frpc not found; `auth-error` → token; `proxy-error` → `remotePort` collision |
| `health.fence` | `passed` | `blocked` → DSH was started without `--trusted-host` |
| `health.publicProbe.status` | `200`/`302`/`401` | `502` → tunnel up, DSH down; error → DNS/nginx/cert |
| `health.hints` | empty | it says exactly what to change |

The DSH launch command is unchanged apart from the fact that the tunnel no longer needs a task:

```text
--host 127.0.0.1 --port 3080
--trusted-host pc-a.BASE_DOMAIN --trusted-host pc-a.BASE_DOMAIN:443
--public-url https://pc-a.BASE_DOMAIN/
```


## 3. Generate the client files (scripts only)

```powershell
cd C:\path\to\dsh-remote
powershell -ExecutionPolicy Bypass -File .\scripts\windows\New-DshClient.ps1 `
  -PcName pc-a `
  -BaseDomain example.com `
  -ServerIp <SERVER_IP> `
  -FrpToken '<64-hex>' `
  -RemotePort 13080 `
  -Root C:\dsh-relay
```

This creates:

```text
C:\dsh-relay\frpc.toml
C:\dsh-relay\start-dsh-web.cmd
C:\dsh-relay\run-dsh-web.cmd
C:\dsh-relay\start-frpc-hidden.vbs
C:\dsh-relay\register-pc-tasks.ps1
```

Any other PC uses the same script with its own name and the port printed by `add-pc.sh`; there is no `pc-a`/`pc-b` allow-list. For example: `-PcName pc-c -RemotePort 13082`.

The generated `start-dsh-web.cmd` contains:

```text
--host 127.0.0.1
--port 3080
--trusted-host pc-a.BASE_DOMAIN
--trusted-host pc-a.BASE_DOMAIN:443
--public-url https://pc-a.BASE_DOMAIN/
```

Both `host` and `host:443` are kept for the stock/legacy browser-trust path. Current web-auth sessions cover remote clients, but preserving the Host header and these flags avoids fence regressions on older builds.

## 4. Test DSH Web manually

```powershell
C:\dsh-relay\start-dsh-web.cmd
```

Wait for a line beginning with `dsh web:`. Then, locally:

```powershell
Start-Process http://127.0.0.1:3080/login
```

The first visit shows the "set administrator account" form. Set a username/password and store it in a password manager. This is **not** the portal password.

If the page loads but remote access later fails, keep this manual test result separate from the tunnel test.

## 5. Test frpc manually (scripts only)

In a second PowerShell:

```powershell
C:\dsh-relay\frpc.exe -c C:\dsh-relay\frpc.toml
```

Look for:

```text
login to server success
start proxy success
```

On the server:

```bash
curl -I http://127.0.0.1:13080
```

A 200/302/303/401 from DSH means the tunnel is up. `502` means the tunnel is up but DSH is not; connection refused means frpc is not connected.

Stop the manual windows before registering tasks to avoid duplicate listeners.

## 6. Register the hidden tasks (scripts only)

```powershell
powershell -ExecutionPolicy Bypass -File C:\dsh-relay\register-pc-tasks.ps1 -PcName pc-a
```

What gets registered:

| Task | Trigger | Action |
|---|---|---|
| `dsh-frpc` | At logon of the current user | `wscript.exe //B //Nologo C:\dsh-relay\start-frpc-hidden.vbs` |
| `dsh-web-<name>` | At logon of the current user | `cmd.exe /c C:\dsh-relay\run-dsh-web.cmd` |

No admin required. Both run at `RunLevel Limited`.

### Why a VBS wrapper

`frpc.exe` is a console program. If Task Scheduler launches it directly, Windows shows a black console. Closing that window sends `Ctrl+C`/`STATUS_CONTROL_C_EXIT` and the tunnel dies.

`start-frpc-hidden.vbs` does:

```vbscript
shell.Run """C:\dsh-relay\frpc.exe"" -c ""C:\dsh-relay\frpc.toml""", 0, True
```

- `0` = hidden window.
- `True` = wait for the process.
- A `Do ... Loop` restarts frpc every 10 seconds if it exits.

The task shows `Running`; `Get-Process frpc | Select MainWindowHandle` shows `0`.

### Why the DSH wrapper is more than `dsh web`

`run-dsh-web.cmd`:

- suppresses stdout (DSH prints a one-time launch token there);
- appends stderr to `C:\dsh-relay\dsh-web.err.log`;
- watches port 3080 with `netstat`, so the task stays `Running` while DSH is alive. If DSH exits, the task exits and Task Scheduler restarts it.

Do not redirect DSH stdout to a shared log. The token is equivalent to control of the DSH instance.

## 7. Verify tasks (scripts only)

```powershell
Get-ScheduledTask -TaskName dsh-frpc,dsh-web-<name> | Select TaskName,State
Get-ScheduledTask -TaskName dsh-frpc,dsh-web-<name> | Get-ScheduledTaskInfo
Get-Process frpc,wscript | Select Id,ProcessName,MainWindowHandle
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

`LastTaskResult 267009` is `0x41301`, "task is currently running". `0xC000013A` usually means someone closed the console window; with the VBS wrapper it should not happen.

Then from the server:

```bash
curl -I http://127.0.0.1:13080
curl -I https://pc-a.BASE_DOMAIN/login
```

## 8. Optional: frpc at boot as SYSTEM (scripts only)

The per-user task starts only after login. If the PC must keep the tunnel up before login, register a SYSTEM startup task:

```powershell
# Elevated PowerShell
powershell -ExecutionPolicy Bypass -File C:\dsh-relay\register-frpc-system-task.ps1
```

This runs the same hidden VBS at boot. It does **not** make DSH available before login; DSH Web is a desktop-session process. For full unattended access, enable Windows auto-login or run DSH as a service (with Session 0 limitations).

## 9. First remote login

1. Open `https://dsh.BASE_DOMAIN/` and pass portal basic auth.
2. Click a registered PC (or enter its name in the portal).
3. On `https://<name>.BASE_DOMAIN/login`, sign in with that PC's DSH admin account.
4. Add the portal to the home screen for PWA behavior.

If the DSH admin password is lost:

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh --profile web auth-reset --password "new-strong-password"
```

`auth-reset` only works after an admin exists; it cannot create the first account.

## 10. Logs and stop/start

```powershell
Get-Content C:\dsh-relay\frpc.log -Tail 50
Get-Content C:\dsh-relay\dsh-web.err.log -Tail 50

Stop-ScheduledTask dsh-frpc
Stop-ScheduledTask dsh-web-<name>
Start-ScheduledTask dsh-frpc
Start-ScheduledTask dsh-web-<name>
```

If you stop a task, also kill any orphaned process:

```powershell
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
```

## 11. Common Windows pitfalls

- **Black window**: task action points directly at `frpc.exe`; change it to the VBS.
- **Tunnel dies on logout**: per-user task; expected.
- **3080 in use**: another DSH/instance; `Get-NetTCPConnection -LocalPort 3080`.
- **`--host 0.0.0.0` rejected**: DSH requires auth for a non-loopback bind; install the plugin or configure native web auth, then check plugin/DSH compatibility.
- **403 `forbidden`**: nginx `Host` header not preserved or `--trusted-host` missing.
- **401 loop**: DSH admin not registered, or cookie not retained; use `/login` on the same hostname.
- **No PWA install**: must be HTTPS, manifest must be 200, service worker scope `/`.