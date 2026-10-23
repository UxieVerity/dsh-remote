# Security model and hardening

## Threat model

The relay exposes a browser UI that can run commands on each PC. Treat DSH access as remote code execution, not as a read-only dashboard.

| Asset | Risk if compromised |
|---|---|
| DSH Web session | Full DSH tools, file access, model/API spend |
| DSH launch token | Equivalent to an owner session |
| frp token | Ability to register a proxy/remote port on the relay |
| Portal basic auth | Access to the portal and links; not DSH itself |
| Server root | Plaintext upstream traffic, config, tokens, certificates |
| TLS private key | Impersonation of the relay |

## Authentication layers

1. **TLS** authenticates the server to the phone and encrypts the public hop.
2. **nginx basic auth** gates the portal (`/srv/dsh-portal`) only. It does not protect the per-PC subdomains by itself.
3. **DSH login** (`dsh-web-startup-auth`) gates `/api/*` and third-party RPC routes on each PC.
4. **frp token** authenticates frpc to frps. It does not authenticate a browser.

Do not describe the portal password as "the DSH password". They are independent.

## Network exposure

Public:

- 80/tcp: ACME and redirect. Some clouds ICP-block new subdomains here; HTTPS still works.
- 443/tcp: nginx.
- 7000/tcp: frps. Must be reachable by all PCs; if possible restrict source IPs.

Never public:

- 7500: frps dashboard.
- 13080-65535: per-PC frp remote ports.
- 3080: DSH Web.
- SSH: restrict to admin IPs and keys.

`frps` should set:

```toml
proxyBindAddr = "127.0.0.1"
webServer.addr = "127.0.0.1"
```

## Token and password handling

- Generate `FRP_TOKEN` with 32 random bytes (64 hex chars). Do not use a human password.
- `frps.toml` mode 640, `root:frp`; `frpc.toml` ACL to the owning Windows user.
- Portal `.htpasswd` mode 640, `root:www-data`.
- DSH passwords are stored as scrypt hashes in `$DSH_HOME/web-auth.json`; the plaintext must not be written to logs.
- Credentials handoff file: 600 on Unix, user-only ACL on Windows. Do not put it in git, chat, or screenshots.
- Do not log DSH stdout: it contains a one-time launch token.

## TLS

- Wildcard certificate via DNS-01.
- TLS 1.2/1.3 only; HSTS on HTTPS server blocks.
- The reference template enables HSTS. Only deploy it after the certificate validates end-to-end; if you stage with a self-signed certificate, remove the HSTS header until the real certificate is in place.
- The server terminates TLS; traffic from nginx to DSH is plaintext. Use a trusted server.
- Keep the private key at `/etc/letsencrypt/live/...`, readable by root only; nginx runs as root for the master process and can read it.

## DSH-specific hardening

- Bind DSH to `127.0.0.1`; never `0.0.0.0`.
- Run the DSH task as the normal user, not Administrator.
- Set `DSH_WORKSPACE` to a dedicated folder if you do not want the agent to start in the full home directory.
- Do not run DSH as a Windows service in Session 0 unless you have verified GUI/tool behavior.
- Keep the DSH plugin and DSH version within the supported range; DSH is a developer preview and breaking changes are possible.
- Restrict model/API keys in the DSH environment; a compromised DSH session can spend them.

## Portal

- Basic auth is a gate, not a full identity system. Use a long random password.
- The PWA service worker caches only static shell files, never `/api/*`.
- Do not iframe DSH; framing protections and cookie `SameSite` rules make it fragile and can weaken origin isolation.
- PWA has no push notifications; do not promise them.

## frps abuse

frps 0.71.x has token auth but no built-in per-IP rate limiting. Options:

- Restrict 7000 to the PCs' egress IPs in the cloud firewall.
- Put fail2ban or an nginx stream proxy in front of 7000 if the provider supports it.
- Use a long random token and rotate it if a PC is lost.
- Monitor `/var/log/frps.log` for unexpected proxy names/remote ports.

## ICP / port 80

Some mainland-China providers return `403` with an ICP block before nginx for new subdomains on HTTP. This is not an nginx auth failure. Use HTTPS and DNS-01; add the subdomains to the filing only if HTTP is required.

## Hardening checklist

- [ ] Only 80/443/7000 public; 7500/13080+/3080 loopback.
- [ ] frps token 64 hex; dashboard password strong; dashboard loopback.
- [ ] Portal basic auth strong; `.htpasswd` 640.
- [ ] DSH admin password strong; not equal to portal password.
- [ ] No DSH launch token in logs.
- [ ] DSH runs as a normal user.
- [ ] TLS trusted without `-k`; HSTS enabled only after validation.
- [ ] Existing website still 200.
- [ ] Secrets in ignored local files, not git.
- [ ] Certificate expiry recorded; renewal method documented.
- [ ] Windows tasks hidden; no black console.
- [ ] User understands logoff/reboot leaves DSH unavailable until login.
