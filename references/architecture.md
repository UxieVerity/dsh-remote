# Architecture

## L1, not L2 or L3

There are three practical remote-access designs:

| Design | What runs on the PC | What the phone sees | Trade-off |
|---|---|---|---|
| **L1 (this repo)** | DSH Web + frpc | The real DSH Web UI through nginx | Simple, no custom DSH protocol; server sees plaintext after TLS |
| L2 | DSH Web + a custom agent | A custom mobile app/chat UI | More mobile-friendly, but must reimplement protocol and maintain it across DSH releases |
| L3 | Tailscale/Headscale client | DSH Web directly over the mesh | Fewer servers, but every device joins a mesh and there is no central portal |

This repo deliberately implements L1: **page/port-level relay**. The server does not parse DSH messages, does not hold DSH sessions, and does not run an agent on the PC.

## Data flow

```text
Phone
  │  HTTPS 443, SNI dsh.example.com
  ▼
nginx :443
  ├─ dsh.example.com  -> /srv/dsh-portal (basic auth + PWA)
  ├─ pc-a.example.com -> http://127.0.0.1:13080
  └─ pc-b.example.com -> http://127.0.0.1:13081
                              │
                              ▼
                          frps :7000
                              ▲
                              │ outbound TCP, token auth
                    ┌─────────┴─────────┐
                    │                   │
                 frpc PC A           frpc PC B
                    │                   │
                    ▼                   ▼
             127.0.0.1:3080      127.0.0.1:3080
             DSH Web             DSH Web
```

- The PCs make **outbound** connections to `SERVER_IP:7000`; no port forwarding on the PC/router.
- `frps` binds remote ports `13080/13081` to loopback only.
- nginx is the only public HTTP/TLS listener.
- DSH binds loopback only; it is never directly reachable from the LAN.

## Hostnames and certificate

Recommended DNS:

| Name | Type | Value | Purpose |
|---|---|---|---|
| `dsh.BASE_DOMAIN` | A | `SERVER_IP` | Portal/PWA |
| `pc-a.BASE_DOMAIN` | A | `SERVER_IP` | PC A |
| `pc-b.BASE_DOMAIN` | A | `SERVER_IP` | PC B |
| `frp.BASE_DOMAIN` | A | `SERVER_IP` | Optional; frpc can use the IP directly |

A wildcard `*.BASE_DOMAIN` certificate covers `dsh`, `pc-a`, and `pc-b`. It does **not** cover the apex `BASE_DOMAIN` or `www`; keep the existing certificate for those names.

Apex/www and wildcard can coexist as separate nginx `server` blocks. Do not replace the existing site's certificate just to add subdomains.

## Trust boundaries

1. **Internet → nginx**: TLS. The certificate is the only thing authenticating the server to the phone.
2. **nginx → frps → PC**: plain HTTP over the frp TCP tunnel. The server root can read it. This is the main reason to use a server you control.
3. **Portal → DSH**: portal basic auth is separate from DSH login. A user who passes basic auth still needs the DSH account.
4. **DSH Web**: `dsh-web-startup-auth` supplies the tested username/password login, allows a non-loopback bind through that auth, and protects `/api/*` plus third-party RPC routes with a signed session cookie. DSH `0.2.1-rc.2` also understands native auth; the plugin remains the tested path.
5. **DSH launch token**: the token printed on stdout is equivalent to full control. It must not be written to shared logs; the Windows wrapper discards stdout.

## Why nginx, not Caddy, in the reference deployment

Both work. nginx is used here because many existing Ubuntu hosts already run nginx on 80/443 and replacing the web server is riskier than adding a site. The repo keeps a generic nginx template; a Caddy variant is easy to derive but is not the tested path.

## WebSocket / streaming

DSH Web needs long-lived HTTP/WebSocket connections. The nginx template includes:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection $dsh_connection_upgrade;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
```

The `map` must live in the `http` context:

```nginx
map $http_upgrade $dsh_connection_upgrade {
    default upgrade;
    ''      close;
}
```

If WebSocket breaks but plain HTTP works, inspect the browser Network panel for a failed `101 Switching Protocols` and check the `Upgrade`/`Connection` headers at nginx.

## Why not iframe the DSH UI

DSH sets framing protections and its UI is not designed for embedding. The portal uses normal links / a separate PWA window. This also avoids cookie/`SameSite` problems between the portal origin and the PC origin.

## Limits

- No push notifications; the PWA must be opened.
- The server is a single point of failure.
- The server sees plaintext upstream traffic.
- PC sleep/hibernate or user logoff breaks the tunnel.
- If the PC reboots and nobody logs in, DSH (and a per-user frpc task) will not start.
- A wildcard certificate renewal needs DNS control; HTTP-01 may be blocked by ICP.
