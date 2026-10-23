# Troubleshooting

Use this order: DNS/TLS -> nginx -> frps -> frpc -> DSH -> auth -> browser.

## 502 Bad Gateway

`502` from nginx means it cannot reach the PC's upstream loopback port (for example `127.0.0.1:13080`). The port is the one printed by `add-pc.sh` and written in `/etc/nginx/dsh-pcs/<name>.conf`.

```bash
ss -lntp | grep -E ':(13080|13081)\b'
curl -sS -D - -o /dev/null http://127.0.0.1:13080/
journalctl -u frps -n 50 --no-pager
```

- No listener: frpc is not connected, or the remote port is not allowed by `allowPorts`.
- Listener but curl fails: frpc's `localPort` is wrong or DSH is not listening on 3080.
- Listener + 200/303: nginx upstream is fine; check `proxy_pass` port.

On Windows:

```powershell
Get-Process frpc
Get-Content C:\dsh-relay\frpc.log -Tail 50
Get-NetTCPConnection -LocalPort 3080 -State Listen
```

## 401 Unauthorized

- Portal 401 without auth: expected basic auth.
- PC `/` 401: expected DSH plugin auth.
- PC `/login` 200 but login fails: wrong DSH password, or you are on the wrong hostname.
- Login succeeds then immediately 401: cookie not retained; check `SameSite`, HTTPS, and whether the browser is using `http://` instead of `https://`.
- DSH launch token in the URL is not a substitute for the account login.

## 403 Forbidden

Identify the body/source:

| Response | Source | Fix |
|---|---|---|
| Plain `forbidden` | DSH Host trust fence (stock/legacy path) | Ensure nginx sends `Host $host`; keep `--trusted-host host` and `host:443` for older startup paths |
| `{"error":"request-not-trusted"}` | Third-party plugin loopback guard | That plugin only allows 127.0.0.1; not fixable in nginx |
| HTML/plain "Non-compliance ICP Filing" / `Server: Beaver` | Cloud ICP block on port 80 | Use HTTPS; add filing if HTTP is required |
| nginx 403 | File permissions or directory index | Check `/srv/dsh-portal` ownership/modes |

## 404 on `/login` or assets

- `/login` 404: plugin not loaded. Check:

  ```powershell
  & "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile web list
  ```

- Portal assets 404: check `/srv/dsh-portal`, nginx `root`, and `try_files`.
- `manifest.webmanifest` 404/incorrect MIME: add `default_type application/manifest+json;`.

## Certificate errors

```bash
openssl x509 -in /etc/nginx/ssl/dsh-relay.pem -noout -subject -enddate -ext subjectAltName
nginx -t
systemctl reload nginx
```

- `NET::ERR_CERT_COMMON_NAME_INVALID`: SAN does not cover the host, or you are using the apex/`www` certificate for a subdomain.
- `ERR_CERT_AUTHORITY_INVALID`: chain missing or wrong file (`fullchain.pem`, not `cert.pem`).
- `curl` works with `-k` but not without: chain/SNI issue; do not call that fixed.
- Renewal hangs: manual DNS hook is waiting; never leave it under `certbot.timer`. Disable the timer or use a DNS API.

## WebSocket / UI loads but actions fail

Symptom: page loads, but live updates never arrive or RPC fails; DevTools shows WebSocket `101` failing.

Check nginx:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $dsh_connection_upgrade;
```

Check `map` exists in the `http` context. Test with browser DevTools -> Network -> WS. A `400`/`426` usually means upgrade headers were stripped.

## add-pc.sh fails

- `the nginx site does not include /etc/nginx/dsh-pcs`: rerun `install-nginx-site.sh`; the main config predates the per-PC include.
- `name is already registered`: remove it first, or use another label.
- `port ... is already allocated or listening`: choose `--port`, or check `ss -lntp | grep <port>`.
- `nginx -t` failure: the script restores the registry/JSON/config. Read the nginx error, fix the generated block or certificate, and retry.
- `pcs.json` not updating: check `/srv/dsh-portal` permissions and `python3`.

## Port 7000 timeout

- Cloud security group missing 7000.
- Host firewall blocking 7000.
- frps not listening: `ss -lntp | grep 7000`.
- Wrong `SERVER_IP` or DNS.
- Corporate proxy blocking raw TCP; use a direct network.

## frpc login fails

```text
login to server failed: authorization failed
```

- Token mismatch between `frps.toml` and `frpc.toml`.
- Token contains a trailing newline/quote.
- frps was restarted with a different config.

Compare hashes without printing the token:

```bash
# server
sed -n 's/^auth\.token = "\(.*\)"/\1/p' /etc/frp/frps.toml | sha256sum
```

```powershell
# client
(Select-String -Path C:\dsh-relay\frpc.toml -Pattern '^auth.token').Line
```

Do not paste tokens into chat.

## Remote port already in use

```text
port already used
```

Another frpc session still holds `13080`. On the PC, kill stale frpc processes; on the server, check `ss -lntp | grep 13080`. The VBS wrapper should prevent this, but a manually started frpc can conflict.

## Black console window

The task action is pointing directly at `frpc.exe`. Change it to:

```text
wscript.exe //B //Nologo C:\dsh-relay\start-frpc-hidden.vbs
```

The VBS uses `WScript.Shell.Run(..., 0, True)` and loops. Verify `MainWindowHandle = 0`.

Closing the old console sends `STATUS_CONTROL_C_EXIT` (`0xC000013A`); after the VBS fix, there is no console to close.

## Task says Ready, not Running

- `267009` (`0x41301`) = running, normal.
- `0xC000013A` = control-C/console closed; fix the hidden wrapper.
- `dsh-web-<name>` exits quickly if DSH fails to start or port 3080 is already in use. Check `dsh-web.err.log`.
- AtLogOn tasks do not run before the user logs in. That is expected; use auto-login or accept the limitation.

## DSH Web exits immediately

Run it manually to see the error:

```powershell
cd C:\dsh-relay
.\start-dsh-web.cmd
```

Look for:

- `--host 0.0.0.0` rejected -> DSH requires auth for a non-loopback bind; install the plugin or configure native web auth, and check plugin/DSH compatibility.
- profile/plugin version mismatch -> check DSH/plugin compatibility.
- port 3080 already in use -> kill stale process.
- DSH_HOME permission error -> use a writable profile home.

## PWA won't install

- Must be HTTPS with a trusted certificate.
- `manifest.webmanifest` must return 200 with `application/manifest+json`.
- Icons 192/512 must be reachable.
- Service worker scope must be `/`; check DevTools -> Application -> Service Workers.
- Some browsers require a user gesture / "Add to Home Screen" menu; there is no automatic install prompt.

## Existing website broke

- Check `nginx -T` for duplicate `server_name`.
- Check the default server block; exact matches should win.
- Restore the timestamped backup, `nginx -t`, reload.
- Do not replace the apex/`www` certificate with the wildcard unless it covers those names (it does not).

## Logs

```bash
journalctl -u frps -n 100 --no-pager
tail -n 100 /var/log/nginx/error.log
tail -n 100 /var/log/nginx/access.log
```

```powershell
Get-Content C:\dsh-relay\frpc.log -Tail 100
Get-Content C:\dsh-relay\dsh-web.err.log -Tail 100
```
