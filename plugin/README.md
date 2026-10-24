# dsh-remote（DSH 插件）

把「终端里的 dsh 连到自建服务器」这件事收进插件里：**渲染 frpc.toml、隐藏窗口跑 frpc、
断线重拉、跟着 dsh 起停、体检与状态汇报**。

它顶替的是 `scripts/windows/` 里那段"接隧道"的铺盖：

| 老方案（skill 脚本） | 现在（插件） |
|---|---|
| `New-DshClient.ps1` 渲染 `frpc.toml` | 插件按 `config.json` 每次启动前渲染（改配置立即生效） |
| `start-frpc-hidden.vbs` + 黑窗口问题 | `spawn(frpc, { windowsHide: true })`，不新建控制台 |
| VBS 里 `Do…Loop` 每 10 秒重启 | 指数退避重拉；认证/端口这类配置错误**停下等人**，不无限撞墙 |
| 计划任务 `dsh-frpc`（登录自启） | dsh 一起来就自启，dsh 退出就收掉 |
| `Get-Process frpc` 看 `MainWindowHandle` 的人工检查 | `dsh_remote_status` 工具 / `/api/dsh-remote/status` |
| `curl -I http://127.0.0.1:13080` 手工验收 | 体检会真的用公网 Host 探一次，把 403 和 502 分开报 |

它**不**做的事，写在这里免得误会：

- 不启动 dsh 本身。插件跑在 dsh 进程里，天然不可能去启动自己（先有 dsh，才有插件）。
  所以「终端里的那条启动命令」还在，只是不用再管隧道了（见下面「启动命令」）。
- 不改服务器。frps / nginx / 证书 / `add-pc.sh` 仍是 skill 的活。
- 不碰 Host 信任围栏的配置本体。它只**探**、然后告诉你该给 dsh 补哪个 `--trusted-host`。

## 安装

插件随这个仓库一起走，包目录是 `plugin/`。装到某个 profile（一般就是 `web`）：

```powershell
$dsh = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh plugin --profile web add "D:\path\to\dsh-remote\plugin"
```

`dsh plugin` 把参数透传给 profile 目录里的 pnpm，所以 `file:` 路径、git、npm 包名都行。
装完**重启一次 dsh**（bundle 层要重启才组装）。确认它进来了：

```powershell
& $dsh plugin --profile web list | Select-String dsh-remote
```

装好而没生效时，DSH 的日志里会出现 `entry did not activate … failed to import`；
本插件没有任何硬依赖（`@deepseek-ai/dsh-tools` 是 optional peer，拿不到会退到本地等价实现），
正常情况下不会因为依赖装不上而整条不激活。

## 配置

配置**不在** profile 的 yml 里，而在：

```text
$DSH_HOME\dsh-remote\config.json      （0600；DSH_HOME 默认 %USERPROFILE%\.dsh）
```

这样 frp token 不会进 profile 配置、也不会和"设置页改了一半"打架。第一次用有三种改法：

**① 直接让模型改（推荐）** —— 在对话里说清楚，模型会调工具：

> 帮我配隧道：pc-a、域名 example.com、服务器 203.0.113.10、remotePort 13080、token 是 xxx

**② 工具** `dsh_remote_configure`，patch 就是配置片段：

```json
{ "pcName": "pc-a", "baseDomain": "example.com", "serverAddr": "203.0.113.10",
  "remotePort": 13080, "token": "<64 hex>" }
```

**③ 回环 HTTP**（脚本/界面用；只接受本机请求）：

```powershell
$body = '{"patch":{"pcName":"pc-a","baseDomain":"example.com","serverAddr":"203.0.113.10","remotePort":13080,"token":"<64 hex>"}}'
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3080/api/dsh-remote/config `
  -ContentType 'application/json' -Body $body
```

字段：

| 字段 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `pcName` | ✓ | — | 小写 DNS 标签，跟服务器上 `add-pc.sh --name` 一致（`pc-a`） |
| `baseDomain` | ✓ | — | 裸域名后缀（`example.com`） |
| `serverAddr` | ✓ | — | 服务器公网 IP 或主机名 |
| `serverPort` | | `7000` | frps 控制端口 |
| `remotePort` | ✓ | — | `add-pc.sh` 打印的那个（13080-65535） |
| `localPort` | | `3080` | dsh 监听端口；拿得到真实端口时以真实端口为准 |
| `token` | ✓ | — | frp token。也可以放 `$DSH_HOME/dsh-remote/frp-token` 文件，**文件优先** |
| `frpcPath` | | | 指了就用它；否则按「状态目录 bin → `C:\dsh-relay` → PATH」找 |
| `trustedHosts` | | `[]` | 额外的 Host（例如局域网名）。公网域名会自动加 |
| `enabled` / `autoStart` | | `true` | 总开关 / 跟着 dsh 自启 |
| `logLevel` | | `info` | trace/debug/info/warn/error（frpc 自己的日志级别） |
| `restartInitialMs` / `restartMaxMs` | | `1000` / `60000` | 重拉退避的起点与上限（重启 dsh 后生效） |

校验口径跟老脚本 `New-DshClient.ps1` 一致（pcName 的 DNS 标签规则、remotePort 区间、
token 长度与不许有双引号、baseDomain 不带首尾点），报错文案也照抄，换实现不换说法。

## 放 frpc

插件不会替你下载 frpc。放这里最省事（会自动找到）：

```text
$DSH_HOME\dsh-remote\bin\frpc.exe
```

版本要和服务器上的 `frps` 一致（本仓库测试基线 `0.71.1`）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\dsh-remote\bin" | Out-Null
# 解压 frp_0.71.1_windows_amd64.zip，把 frpc.exe 拷进去
& "$env:USERPROFILE\.dsh\dsh-remote\bin\frpc.exe" -v
```

放在老的 `C:\dsh-relay\frpc.exe` 也认（迁移时不用挪）。

> **和 `dsh-web-startup-auth` 一起用时**：那一层会在本插件之前拦 `/api/*`。
> 非回环 Host（= 从隧道进来）先被它 302 到 `/login`；回环的第一次请求会 303 +
> `set-cookie: dsh-auth-…` 再跳回原路径。所以设置页在浏览器里照常工作（浏览器自动处理这两跳），
> 而脚本直接打接口时要带 cookie 或跟随跳转。

## 两个"自己会修"的坑

- **桌面版的端口每次都变**（1312、9685……）。插件不猜：它查自己进程的监听端口
  （`netstat -ano` 按 PID 过滤），发现和 toml 里写的不一样就重排 + 重启隧道。
  前 60 秒每 2 秒校一次，对上就停。
- **残留 frpc 抢 remotePort**（上次崩溃、或重复启动留下的）。起之前先扫掉"用同一份 toml"
  的残留进程，否则新进程会 `port already used` → 公网 502，而状态却显示 connected。

## 桌面版（Electron 应用）才会遇到的四件事

1. **端口每次启动都是随机的**。别把 `localPort` 当成"配一次就完事"——插件会实时探测自己进程的
   监听端口、改 `frpc.toml`、必要时重启 frpc（最多追 60 秒）。手动改配置时填个大概值也不会错。
2. **没有 `--trusted-host` 可传**。DSH 的 Host 围栏会把公网域名的 `/api/*` 一律打成 403，
   表现为「能打开页面、能登录、却一直重新连接中」。要改 profile：

   ```yaml
   # %USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml
   - id: connection
     name: "@deepseek-ai/dsh-client-connection"
     config:
       trustedHosts: !!js "['pc-a.example.com', ...(ctx.webStartup?.trustedHosts ?? [])]"
   ```

   条目必须是**裸 `host[:port]`**（不带 `http://`、不带路径），写错会让 profile 加载失败、
   应用起不来。改完保存即生效（loader 会热加载），不用重启。
3. **重启应用会留下旧的 frpc**。旧进程攥着 `remotePort`，新的就 `proxy-error`（而公网反而是通的，
   因为旧的那个在转发）。插件现在会自己清扫 + 重试两轮；手工救急用 `taskkill /F /IM frpc.exe`。
4. **改插件源码后必须让 profile 重新装一次**：`file:` 依赖是**拷贝**，不是软链；而且应用运行时
   `dsh plugin --profile desktop ...` 会拒绝执行（要完全退出）。嫌麻烦就手动同步 `lib/` 与 `client.js`
   到 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-remote`，下次启动生效。

> 附带一条 Windows 脚本的坑：**没有 BOM 的 UTF-8 `.ps1` 会被 PowerShell 5.1 当 GBK 读**，中文全变乱码。
> 要给用户脚本就写 BOM；`.cmd` 包一层的话保持纯 ASCII 并先 `chcp 65001`。

## 设置页

装好并**重启 dsh** 之后，设置里会多一页「**远程接入**」（和「刷B站」「大肥鱼」并列），
不用再靠改 JSON 或喊模型：

- **现在怎么样**：隧道状态徽标（已连上 / 连不上正在重试 / 找不到 frpc …）、公网地址、
  frpc 版本、还缺哪些配置；「重连」「停止」「体检」「刷新」四个按钮
- **服务器与这台电脑**：pcName、baseDomain、serverAddr、frps 端口、remotePort、localPort、
  token（已设置就留空，不会把旧 token 读出来给你看）
- **怎么跑**：启用开关、跟着 dsh 自启、frpc 路径、日志级别、「保存并重连 / 只保存 / 撤销改动」
- **frpc 日志**：展开看最近 300 行（只在内存里，不落盘）
- **远程访问地址**：点一下「获取带令牌的公网地址」，直接把 `https://pc-b.example.com/?token=…`
  拿给你（默认打码，可显示/复制）

最后这条是关键：dsh 每次启动都随机生成一个 launch token，只打印在启动日志里 ——
桌面版没人看得到那行。插件改用 dsh 自己的 `connection.authenticatedUrl()` 把它拼出来，
**只走本机回环接口**（隧道那头 403），不进工具输出、不写盘、不进日志。

这一页调的是插件的回环接口（§/api/dsh-remote/*§），**只认本机 Host**：
从隧道（§pc-a.example.com§）进来的请求一律 403 —— 所以配置只能在跑 dsh 的那台电脑上改，
远端只能看 dsh 自己的页面，不能动隧道配置。

## 启动命令

dsh 还是由你（或开机项）启动，只是参数里那两件事可以少操心：

```powershell
& $dsh --profile web --no-open --host 127.0.0.1 --port 3080 `
  --trusted-host pc-a.example.com --trusted-host pc-a.example.com:443 `
  --public-url https://pc-a.example.com/
```

- `--host 127.0.0.1`：只监听回环（远程入口由 nginx 从隧道那头进来），
  `--host 0.0.0.0` 会被 dsh 自己拒绝。
- `--trusted-host`：**这条不能省**。DSH 对非回环来源的 `Host` 有信任围栏，
  少了它 nginx 转进来的请求一律 403。插件会探出来并提示（见「排障」）。
- `--public-url`：只影响 dsh 打印/打开的地址，不参与信任判断。

插件起来后会自动连隧道，不需要再注册 `dsh-frpc` 计划任务。**迁移时记得停掉老任务**，
否则两个 frpc 抢同一个 `remotePort`：

```powershell
Stop-ScheduledTask dsh-frpc -ErrorAction SilentlyContinue
Unregister-ScheduledTask dsh-frpc -Confirm:$false -ErrorAction SilentlyContinue
Get-Process frpc -ErrorAction SilentlyContinue | Stop-Process -Force
```

## 让它自己开机跑

插件跟着 dsh 走，所以"开机自动连" = "开机自动起 dsh"。最省事的还是原来的
`dsh-web-<name>` 计划任务（那一段没被插件接管：它管的是"启动 dsh"）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\register-pc-tasks.ps1 -PcName pc-a
```

该脚本会连 `dsh-frpc` 一起注册 —— 装了插件之后**只需要 `dsh-web-<name>` 这条**。
注册完把 `dsh-frpc` 停掉/删掉即可（插件已经在进程内管隧道了）。

## 验收

对话里：

> 看一下远程接入状态

模型会调 `dsh_remote_status`（`deep=true` 会真的探一次公网），返回里有：

- `tunnel.state`：`stopped` / `starting` / `connected` / `backoff` /
  `auth-error` / `proxy-error` / `bin-missing` / `error`
- `tunnel.log`：最近若干行 frpc 日志
- `health.fence`：用公网 Host 探本地的结果 —— `passed` / `blocked`
- `health.publicProbe`（deep）：公网入口的状态码
- `health.hints`：**该改哪一条**

脚本/终端里：

```powershell
Invoke-RestMethod http://127.0.0.1:3080/api/dsh-remote/status | ConvertTo-Json -Depth 6
Invoke-RestMethod "http://127.0.0.1:3080/api/dsh-remote/status?deep=1" | ConvertTo-Json -Depth 6
```

服务器上仍然可以按老办法从外面验：

```bash
curl -I http://127.0.0.1:13080              # 200/302/303/401 = 隧道通
curl -I https://pc-a.example.com/login      # 200 = 一路通到 dsh
```

## 工具

| 工具 | 干什么 |
|---|---|
| `dsh_remote_status` | 状态 + 日志 + 体检（`deep=true` 加探公网，慢几秒） |
| `dsh_remote_control` | `start` / `stop` / `restart` / `check` |
| `dsh_remote_configure` | 合并写 `config.json`（未知字段会被拒），连接相关字段变了自动重拉 |

HTTP 接口（**只接受本机**，非 loopback 一律 403）：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/dsh-remote/status` | 同 `dsh_remote_status`（`?deep=1`） |
| POST | `/api/dsh-remote/control` | `{"action":"start|stop|restart|check","wait":true}` |
| GET/POST | `/api/dsh-remote/config` | 读（脱敏）/ 写 `{"patch":{...},"restart":true}` |

## 排障

| 症状 | 插件怎么说 | 真正的修法 |
|---|---|---|
| `tunnel.state=bin-missing` | `hint` 里给出该放哪 | 把 `frpc.exe` 放进 `$DSH_HOME/dsh-remote/bin/` 或配 `frpcPath` |
| `auth-error` | 停在这里不重试，等改配置 | token 与服务器 `frps.toml` 不一致 |
| `proxy-error` | 同上 | 常见是 `remotePort` 撞了（同一端口只能一台 PC 用） |
| `health.fence=blocked` | `hints` 里是完整的两条 `--trusted-host` | 启动 dsh 时补上（见「启动命令」） |
| `publicProbe.status=502` | 「隧道通了，DSH 没应答」 | dsh 挂了 / 端口不对；先在本机 `127.0.0.1:3080` 自测 |
| 公网连不上、本地正常 | `publicProbe` 报错（超时/拒连） | DNS / 证书 / nginx / 服务器 7000 是否开放 |
| 401 循环 | 栅栏已过，只是没登录 | 在 `https://pc-a.example.com/login` 用这台 PC 的 dsh 账号登录 |

## 安全边界

- `config.json` 里可能有 token，权限收到 0600；也可以改用 `frp-token` 文件。
- 工具与 HTTP 接口**只服务回环**：非 127.0.0.1/::1 的请求直接 403。`/api` 下的状态接口
  仍要经过 DSH 自己的认证，别把远程的 dsh 页面当成"没登录也能看"。
- frpc 的日志走 stdout，由插件收在内存环形缓冲里（最近 300 行），`dsh_remote_status` 的
  `tunnel.log` 就能看到，**不落盘**（写文件会让 frpc 不再输出到控制台，监督器就瞎了）。
  日志会做 token 抹除（`scrub`），但分享前仍建议自己扫一眼。
- 隧道是「这台电脑主动外连」，不需要在路由器上开端口，也不要把 dsh 改成 `0.0.0.0`。
- 服务器 root 能终止 TLS 并看到明文 HTTP —— 这条在 skill 的 `references/security.md` 里说过，
  插件没有改变这个前提。

## 开发

```bash
cd plugin
node test/run.mjs        # 42 项：配置校验 / toml / 定位 / 体检 / 状态机 / apply 冒烟
```

源码地图：

| 文件 | 职责 |
|---|---|
| `lib/index.js` | 插件入口：装配配置、监督器、工具与 HTTP 接口，自启与收摊 |
| `client.js` | 浏览器半边：设置里那一页「远程接入」（自注册脚本，非 ESM） |
| `lib/config.js` | 配置默认值/校验/原子写/脱敏/派生值（域名、信任清单） |
| `lib/frpc.js` | 找 frpc、渲染 `frpc.toml`、问版本 |
| `lib/supervisor.js` | 进程看护：spawn/隐藏窗口/日志环/状态机/退避重拉/清理残留 pid |
| `lib/trust.js` | 体检：本地监听、Host 围栏、公网入口，以及人话结论 |
| `lib/hostdeps.js` | 从宿主树取 `defineTool`（拿不到用本地等价实现） |
| `AGENTS.md` | 给未来接手的 AI/人看的操作顺序与坑 |
| `cordis.patch.yml` | bundle patch：把 `dsh-remote` 这一行插进 profile |

改代码时请守住这两条：

1. **任何时候都不让插件因为"某个可选服务不存在"而整条不激活** —— 工具、HTTP 接口、
   `webStartup` 全部走 `ctx.inject` 可选注入；隧道本体零依赖。
2. **报错文案要能用** —— 写给深夜看日志的人：说清"是什么、为什么、下一步点哪里"。