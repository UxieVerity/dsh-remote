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
- `plugin/`：**DSH 插件** `dsh-remote` —— 把 PC 端"接隧道"那一段收进插件（渲染 frpc.toml、
  隐藏窗口跑 frpc、断线重拉、随 dsh 起停、体检与状态工具），不再需要 VBS + 计划任务。
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

## 在 Windows 上用插件接隧道（推荐）

PC 端原来靠 `start-frpc-hidden.vbs` + 计划任务 `dsh-frpc` 维持隧道。现在这一段由插件接管：

```powershell
# 1. 装插件（装进 dsh 的 web profile）
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile web add "D:\path\to\dsh-remote\plugin"

# 2. 重启一次 dsh（bundle 层要重启才组装）

# 3. 把 frpc 放到插件会自己找的位置
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\dsh-remote\bin" | Out-Null
# 解压 frp_0.71.1_windows_amd64.zip，把 frpc.exe 拷进去
```

然后在 dsh 里直接说：

> 帮我配隧道：pc-a、域名 example.com、服务器 <SERVER_IP>、remotePort 13080（add-pc.sh 打印的那个）、token 是 xxx

模型会调 `dsh_remote_configure` 写进 `$DSH_HOME\dsh-remote\config.json`（0600），
隧道随后自动拉起。看状态就说「看一下远程接入状态」，它会调 `dsh_remote_status`
（`deep=true` 会真的从这台电脑探一次公网入口）。

**迁移注意**：插件在进程内管隧道，所以老的计划任务 `dsh-frpc` 要停掉删掉，
否则两个 frpc 会抢同一个 `remotePort`：

```powershell
Stop-ScheduledTask dsh-frpc -ErrorAction SilentlyContinue
Unregister-ScheduledTask dsh-frpc -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
```

只保留 `dsh-web-<name>` 那条任务（它管"开机启动 dsh"，插件跟着 dsh 走）。

启动命令仍然需要 `--trusted-host`（DSH 的 Host 信任围栏）：

```powershell
& $dsh --profile web --no-open --host 127.0.0.1 --port 3080 `
  --trusted-host pc-a.example.com --trusted-host pc-a.example.com:443 `
  --public-url https://pc-a.example.com/
```

细节见 [`plugin/README.md`](plugin/README.md)。

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
- **隧道由插件持有，dsh 由系统启动**：插件跑在 dsh 进程里，所以它接管的是"连出去"的一侧；"把 dsh 拉起来"仍然交给计划任务。插件随 dsh 起停，不需要单独的 `dsh-frpc` 任务。
- **Host 围栏仍然是硬要求**：DSH 只接受「回环 / 监听地址 / `trustedHosts` 白名单」三种 `Host`，
  其余一律 403——而且它跑在**认证之前**，所以症状是「登录成功了但接口全 403」。终端 `dsh web` 传
  `--trusted-host`；**桌面应用没有这个入口**，要改 profile 的 `cordis.patch.yml`（见下）。
  插件的价值在于**探出来并说清楚**：带公网 Host 打一次本地，把 403（围栏）和 502（隧道通但 dsh 没起）分开报。
- **证书用 DNS-01 通配符**：`*.example.com` 覆盖 `dsh` 和任意一层电脑子域名；不覆盖裸域，裸域继续用原证书。

## 安全边界

- 服务器 root 能终止 TLS，能看到转发到 DSH 的明文 HTTP；不要把不可信服务器当作零信任边界。
- DSH token / 管理员密码等同于远程代码执行权限；只放在受控文件，权限最小化。
- 仅公网开放 80/443/7000；`7500`（frps dashboard）、`13080-65535`（frp 远程端口）、`3080`（DSH）都只绑定回环。
- 不要把真实域名、IP、token、密码写进本仓库；`.gitignore` 已忽略 `deploy.local/`、证书和本地配置。

## 踩过的坑（都是真事）

| 症状 | 真正的病根 | 修法 |
|---|---|---|
| 页面能开、能登录，但 UI 常驻「重新连接中」，会话列表空 | DSH 的 **Host 围栏**（`/api/*` 403，`/api/auth/*` 却是 200） | 把域名加进 `trustedHosts`；桌面版改 profile 的 `cordis.patch.yml`，**保存即生效**（热加载） |
| 公网 502，但 PC 上 `127.0.0.1` 正常 | 桌面版端口是**运行时随机**的，`frpc.toml` 里写死了旧值 | 让插件自己探（它会实时改并重启 frpc）；别手工写死 |
| `tunnel.state=proxy-error`，公网却还能用 | 重启应用**留下了旧 frpc**，攥着 `remotePort`，而公网走的是它的旧转发 | `taskkill /F /IM frpc.exe`；插件已内置清扫 + 重试两轮 |
| 手机上打开公网地址要求「复制带 token 的链接」 | 那是**原生**认证：token 每次进程启动随机生成，只打印在启动日志里 | 装 `dsh-web-startup-auth`：用户名密码登录 + 签名会话（默认 14 天）。插件另提供本机回环接口代取 token，当备用 |
| 改完插件源码却不生效 | `file:` 依赖是 pnpm **拷贝**不是软链；且应用运行时 `dsh plugin --profile desktop` 会拒绝执行 | `remove` 再 `add`，或完全退出应用后手动同步 `lib/`、`client.js` |
| 交付给用户的 `.ps1` 中文全乱码 | PowerShell 5.1 读**无 BOM** 的 UTF-8 脚本会按 GBK 解码 | 写 UTF-8 **BOM**；`.cmd` 外壳保持纯 ASCII 并先 `chcp 65001` |
| 桌面版设置页改了插件配置，重启后没了 | 插件配置不写 profile yml（怕 token 进仓库），在 `$DSH_HOME\dsh-remote\config.json` | 这是**故意的**：token 不进 profile/仓库。要改就走设置页或工具 |

排查入口：`references/troubleshooting.md`（英文，含判定表与命令）、`plugin/README.md`「桌面版才会遇到的四件事」。

## 目录

```text
dsh-remote/
├─ SKILL.md
├─ README.md
├─ LICENSE
├─ .gitignore
├─ plugin/                 ← DSH 插件 dsh-remote（PC 端隧道）
│  ├─ package.json
│  ├─ cordis.patch.yml
│  ├─ README.md
│  ├─ lib/
│  │  ├─ index.js          （入口：配置/监督器/工具/HTTP）
│  │  ├─ config.js         （配置校验与原子写）
│  │  ├─ frpc.js           （找 frpc、渲染 frpc.toml）
│  │  ├─ supervisor.js     （进程看护、退避重拉）
│  │  ├─ trust.js          （Host 围栏与公网探测）
│  │  └─ hostdeps.js       （从宿主树取 defineTool）
│  └─ test/run.mjs
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