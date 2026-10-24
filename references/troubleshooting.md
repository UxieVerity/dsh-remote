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

Four different layers can answer 403 — identify the body first:

| Response | Source | Fix |
|---|---|---|
| plain `forbidden` | **DSH Host/Origin fence** — the usual culprit | its `Host` is not loopback, not the listener bind IP, and not in `trustedHosts`; see below |
| `{"error":"request-not-trusted"}` | a third-party plugin's loopback guard (this repo's `dsh-remote` included) | by design: that API serves 127.0.0.1 only |
| `{"error":"unauthorized"}` | the login plugin or native auth | not logged in, or the session expired |
| `"Non-compliance ICP Filing"` / `Server: Beaver` | cloud ICP block on port 80 | use HTTPS; add filing if HTTP is required |
| nginx's own 403 | file permissions / directory index | check `/srv/dsh-portal` ownership and modes |

### The Host fence (the 403 that impersonates a login bug)

`isTrustedApiRequest()` accepts a request only when its `Host` is **one** of:

1. a loopback hostname — `localhost`, `127.0.0.0/8`, `[::1]`;
2. an authority listed in `trustedHosts`;
3. the listener's own bind IP literal;

and, when the request carries `Origin`, that origin must be the same authority (and `Sec-Fetch-Site`
must not be `cross-site`). Everything else gets a bare `forbidden` 403.

So a browser arriving through nginx sends `Host: pc-a.example.com` and is refused **even with a valid
session cookie**. Pages and `/api/auth/*` are unaffected, which is exactly why it looks like a password
problem. nginx cannot talk its way out of this — the value has to reach dsh.

Terminal `dsh web`:

```powershell
dsh web --trusted-host pc-a.example.com
# older startup plugin also wants the explicit port form
dsh web --trusted-host pc-a.example.com --trusted-host pc-a.example.com:443
```

Desktop app (no `--trusted-host` on the command line): add the row override to the profile patch,
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`:

```yaml
- id: connection
  name: "@deepseek-ai/dsh-client-connection"
  config:
    trustedHosts: !!js "['pc-a.example.com', ...(ctx.webStartup?.trustedHosts ?? [])]"
```

- Entries are **bare `host[:port]`** in canonical form: lowercase, no scheme, no path. A port-less
  entry matches the hostname on any port; `host:443` matches 443 only.
- A malformed entry **fails the profile load loudly** — the app refuses to start. Copy the shape exactly.
- The loader watches `cordis.patch.yml`: saving it is enough, no restart.
- A patch replaces the targeted row's whole `config`. `recovery`, `cookieMaxAgeDays` and
  `maxRequestBodyBytes` therefore fall back to their defaults, which is what you want here.

## UI stuck on "重新连接中" / reconnecting

Page loads, login succeeds, session cookie is there — but the status pill never turns green and the
session list stays empty.

Read the access log instead of the browser:

```bash
tail -60 /var/log/nginx/access.log | grep 'pc-a.example.com'
```

This signature is the Host fence, not a bad password:

```text
"POST /api/auth/status      200"    <- login "worked"
"POST /api/settings/describe 403"   <- every few seconds, retrying
"GET  /api/remote.mux        403"
"POST /api/session/modelCatalog 403"
```

Fix with `trustedHosts` (see above). A healthy client shows `200` for those same endpoints — that
flip, in the log, is the proof, and it needs no app restart.

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

**Check the Host fence first** if the page and login work: a `403` on `/api/remote.mux` looks exactly
like a broken WebSocket and needs no nginx change (see [403 Forbidden](#403-forbidden)).

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

Another frpc session still holds `13080`. On the PC, kill stale frpc processes; on the server,
check `ss -lntp | grep 13080`. The VBS wrapper should prevent this, but a manually started frpc can conflict.

With the `dsh-remote` plugin this signature has a specific cause: **the DSH process is restarted but the
old frpc outlives it** (kill the app, or let it crash), so the new instance's frpc loses the race for
`remotePort`. Symptom is `tunnel.state=proxy-error` while the public URL still answers — the *zombie*
is holding the port and forwarding to the port the previous process had.

```powershell
# who is holding it, and where are they pointing
Get-CimInstance Win32_Process -Filter "Name='frpc.exe'" |
  ForEach-Object { "$($_.ProcessId)  $($_.CommandLine)" }
# clear them; the plugin's supervisor respawns its own
taskkill /F /IM frpc.exe
```

The plugin (`dsh-remote` 0.1.0) sweeps strays once per start and also treats `port already used` as recoverable:
it sweeps, kills its own child, and retries up to twice before settling on `proxy-error`. If it still
lands there, the survivor belongs to *another* config file — check the `-c` argument above.

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