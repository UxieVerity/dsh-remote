# 给 AI 助手看的（本目录 = 一个 DSH 插件）

`dsh-remote` 是 `dsh-remote` 这个 skill 仓库里的**插件**：它把 Windows PC 上
「终端里的 dsh 连到服务器」那一段（frpc 隧道）接管了。装它之前先看 `../SKILL.md` 的
Phase 4-A，别自己另起一套。

## 帮用户装的时候，按这个顺序

1. **先确认 frpc 在不在**：`$DSH_HOME\dsh-remote\bin\frpc.exe` → `C:\dsh-relay\frpc.exe` → `PATH`。
   版本要和服务器上的 frps 一致（基线 `0.71.1`）。插件**不负责下载** frpc，别承诺它会下。
2. 装插件：`dsh plugin --profile web add "<这个目录>"`，然后**提醒用户重启一次 dsh**
   （bundle 层要重启才组装）。
3. 配配置：让模型调 `dsh_remote_configure` 写进 `$DSH_HOME\dsh-remote\config.json`（0600）；
   必填 `pcName` / `baseDomain` / `serverAddr` / `remotePort` / `token`。
   `remotePort` 是服务器上 `add-pc.sh` 打印的那个，不要猜。
4. **收掉老计划任务**：插件在进程内管隧道，`dsh-frpc` 还在就会两个 frpc 抢同一个 `remotePort`。
   只留 `dsh-web-<name>`（它管"开机起 dsh"，插件跟着 dsh 走）。
5. 让用户验收时用「看一下远程接入状态」（= `dsh_remote_status`，`deep=true` 会真探公网），
   别让他去 `Get-Process` 里找。

## ⚠️ 五个容易踩的坑

- **Host 围栏（403）**。DSH 对非回环 Host 有信任围栏，少了它 nginx 进来的 `/api/*` 一律 403，
  而页面和登录反而正常——症状是「能登录、一直重新连接中」。终端 `dsh web` 传 `--trusted-host`；
  **桌面版没有这个入口**，要改 profile 的 `cordis.patch.yml`（`connection` 行的 `trustedHosts`
  写裸 `host[:port]`，写错会让应用起不来，改完热加载生效）。
- **桌面版端口每次随机**。插件会实时探测并重写 `frpc.toml`；别手写死端口后就不再管。
- **重启应用会留下旧 frpc** 抢 `remotePort` → `proxy-error`（此时公网可能还是通的，别被骗）。
  插件会清扫并重试两轮；救急 `taskkill /F /IM frpc.exe`。
- **`file:` 依赖会被 pnpm 拷贝**，改完插件源码必须 `dsh plugin remove` 再 `add`，否则改的不生效
  （本仓库开发时踩过）。
- **别把 token 写进仓库/issue/日志**。它在 `config.json`（0600）或 `frp-token` 文件里；
  frpc 的日志走 stdout 由插件收在内存里（不落盘），`scrub` 会抹掉其中的 token。

## 仓库结构（改代码时看这里）

- `lib/index.js` —— 入口：装配配置、监督器、三个工具、三个回环 HTTP 路由、自启与收摊
- `client.js` —— 设置里那页「远程接入」；`window.__ModuleLoader__.load` 自注册，走 `slots.register('settings.section')`
- `lib/config.js` —— 默认值 / 校验（口径对着老脚本 `New-DshClient.ps1`）/ 原子写 / 脱敏
- `lib/frpc.js` —— 找 frpc、渲染 `frpc.toml`、问版本
- `lib/supervisor.js` —— 进程看护：`windowsHide` 子进程、日志环、状态机、退避重拉、清理残留 pid
- `lib/trust.js` —— 体检：本地监听、Host 围栏（会真的带公网 Host 打一次本地）、公网入口
- `lib/hostdeps.js` —— 从宿主树取 `defineTool`（拿不到退到本地等价实现）
- `test/run.mjs` —— `node test/run.mjs`，42 项，跑完才知道有没有把状态机改坏

## 约定

- 运行数据一律在 `$DSH_HOME/dsh-remote/`，**不写进包目录**。
- 任何可选服务（`tools` / `webServer` / `webStartup`）都走 `ctx.inject` 可选注入：
  **绝不因为某个服务缺失让整条插件不激活**。
- 报错文案写给人看：说清"是什么、为什么、下一步做什么"。