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

## 3. Generate the client files

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

## 5. Test frpc manually

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

## 6. Register the hidden tasks

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

## 7. Verify tasks

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

## 8. Optional: frpc at boot as SYSTEM

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
