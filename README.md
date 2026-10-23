# dsh-remote

一个可复用的 **DSH 远程访问部署技能（skill）**：用 `frp` TCP 隧道 + `nginx` TLS 反向代理 + PWA 门户，把多台 Windows 电脑上的 DSH Web UI 暴露给手机。

这不是把 DSH 的 API 重写一遍的 L2 方案。它是 **L1 页面级中转**：

```text
手机浏览器
   │ HTTPS 443
   ▼
┌─────────────────────────────┐
│ Ubuntu 服务器                │
│  nginx：TLS + 门户 + 反代    │
│  frps：7000，只做 TCP 转发   │
└─────────────┬───────────────┘
              │ frp 隧道（电脑主动外连）
      ┌───────┴────────┐
      ▼                ▼
  Windows PC 1     Windows PC N
  frpc              frpc
  127.0.0.1:3080    127.0.0.1:3080
  DSH Web           DSH Web
```

电脑数量不写死：每台电脑用 `add-pc.sh` 分配一个唯一的回环端口，并生成自己的 nginx server block；门户从 `pcs.json` 读取列表。

手机看到的仍然是每台电脑真实的 DSH Web UI；服务器只负责 TLS、门户和 TCP 转发，不执行 DSH 任务。

## 这个仓库是什么

- `SKILL.md`：给 DSH agent 的技能入口，描述部署流程、硬性约束和验收标准。
- `references/`：服务器、Windows、架构、安全、排障的详细说明。
- `templates/`：`frps`、`frpc`、nginx、PWA 门户模板。
- `scripts/server/`：Ubuntu 上的安装与验证脚本。
- `scripts/windows/`：Windows 上的无窗口 frpc、DSH Web 任务和配置生成脚本。

## 安装为 DSH skill

把仓库放到 DSH 的用户技能目录：

```powershell
git clone <REPO_URL> "$env:USERPROFILE\.dsh\skills\dsh-remote"
```

Linux/macOS：

```bash
git clone <REPO_URL> ~/.dsh/skills/dsh-remote
```

如果你的 DSH 构建使用别的技能根目录，把整个仓库目录指向它即可；入口始终是 `SKILL.md`。

安装后在 DSH 里直接说：

> 帮我把这台 Windows 电脑和一台 Ubuntu 服务器配置成手机可访问的 DSH 远程入口，使用 frp + nginx + PWA 门户。

## 快速开始

完整步骤见 `SKILL.md` 和 `references/`。最短路径：

1. **准备变量**：域名、服务器公网 IP、frp token、门户密码、DSH 管理员密码。真实值只放在本机 `deploy.local/`，不提交。
2. **DNS**：`dsh` 加每台电脑的子域名（或 `*.example.com`）指向服务器。
3. **证书**：用 DNS-01 申请 `*.example.com` 通配符证书；HTTP-01 在部分云厂商会被 ICP/备案拦截。
4. **服务器**：安装 `frps`，安装 nginx 门户，然后对每台电脑运行 `add-pc.sh` 分配端口并生成 server block。
5. **Windows**：安装 `dsh-web-startup-auth`，用隐藏窗口的 VBS 启动 `frpc`，注册登录自启任务。
6. **验收**：门户返回 401/200，PC 的 `/login` 返回 200，登录后 `/` 返回 200。

## 关键设计

- **不写死电脑数量**：`add-pc.sh` 为每台电脑分配唯一的回环端口并生成一个 nginx server block；加 PC C、D、...、N 不需要改主配置。端口池默认 13080-65535，不是只支持两台。
- **手机不直连电脑**：电脑只主动外连服务器的 7000，不需要公网 IP、端口映射或路由器设置。
- **DSH 只监听回环**：`127.0.0.1:3080`，不暴露到局域网。
- **服务器只转发**：不解析、不重写 DSH 业务协议；nginx 保留真实 `Host`，让 DSH 的 Host 信任围栏和登录插件正常工作。
- **分层认证**：TLS 保护传输；门户 basic auth 只保护入口页；每台 PC 另有独立的 DSH 用户名/密码（`dsh-web-startup-auth`）。
- **无窗口后台**：Windows 计划任务通过 `wscript.exe` 调用 VBS，以隐藏窗口启动 `frpc`；不会出现黑色控制台。
- **证书用 DNS-01 通配符**：`*.example.com` 覆盖 `dsh` 和任意一层电脑子域名；不覆盖裸域，裸域继续用原证书。

## 安全边界

- 服务器 root 能终止 TLS，能看到转发到 DSH 的明文 HTTP；不要把不可信服务器当作零信任边界。
- DSH token / 管理员密码等同于远程代码执行权限；只放在受控文件，权限最小化。
- 仅公网开放 80/443/7000；`7500`（frps dashboard）、`13080-65535`（frp 远程端口）、`3080`（DSH）都只绑定回环。
- 不要把真实域名、IP、token、密码写进本仓库；`.gitignore` 已忽略 `deploy.local/`、证书和本地配置。

## 目录

```text
dsh-remote/
├─ SKILL.md
├─ README.md
├─ LICENSE
├─ .gitignore
├─ references/
│  ├─ architecture.md
│  ├─ variables.md
│  ├─ server.md
│  ├─ windows.md
│  ├─ security.md
│  └─ troubleshooting.md
├─ templates/
│  ├─ frps.toml.template
│  ├─ frpc.toml.template
│  ├─ frps.service
│  ├─ nginx-dsh-relay.conf.template
│  ├─ nginx-pc.conf.template
│  └─ portal/
├─ scripts/
│  ├─ server/
│  │  ├─ install-frps.sh
│  │  ├─ install-nginx-site.sh
│  │  ├─ add-pc.sh
│  │  ├─ remove-pc.sh
│  │  ├─ issue-wildcard-cert.sh
│  │  └─ verify-deployment.sh
│  └─ windows/
│     ├─ New-DshClient.ps1
│     ├─ install-dsh-plugin.ps1
│     ├─ register-pc-tasks.ps1
│     ├─ register-frpc-system-task.ps1
│     ├─ run-dsh-web.cmd
│     ├─ start-dsh-web.cmd.template
│     └─ start-frpc-hidden.vbs
```

## License

MIT
