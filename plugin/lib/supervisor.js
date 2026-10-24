/**
 * lib/supervisor.js —— frpc 进程的看护
 * ============================================================================
 * 这一层顶替了老方案里的三样东西：
 *   - `start-frpc-hidden.vbs`（隐藏窗口 + 每 10 秒重启）
 *   - 计划任务 `dsh-frpc`（登录自启）
 *   - `Get-Process frpc | Select MainWindowHandle` 那套人工检查
 *
 * 做法：`spawn(..., { windowsHide: true })` —— frpc 是控制台程序，但作为 dsh 的
 * 子进程、且不新建控制台，**根本不会出现黑窗口**；退出就按指数退避重拉，
 * dsh 退出（插件 dispose）时把子进程一起收掉。
 *
 * 状态机（对外只暴露 state 字段）：
 *   stopped → starting → connected → (exited) → backoff → starting …
 *                                     ↘ bin-missing / spawn-error（不再重试）
 * ============================================================================
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { pidFilePath } from './paths.js'

const DEFAULT_MAX_LOG_LINES = 300

/** frpc 的日志里这几种行决定状态。 */
const PATTERNS = [
  { re: /login to (?:the )?server success/i, kind: 'connected' },
  { re: /start proxy success/i, kind: 'proxy' },
  // 认证失败：只有这几句才值得停下等人改配置
  { re: /authentication failed|token in login doesn't match|authorization failed|invalid (?:token|user)|user [.*] not found/i, kind: 'auth-error' },
  // 端口/代理被占：改配置才有用
  { re: /start error|port already used|proxy .* already (?:used|exists)/i, kind: 'proxy-error' },
  // 连不上服务器：这是暂态（服务器没起、断网、换 IP），必须继续退避重试，绝不能当致命错误
  { re: /connect to server error|login to server failed|dial tcp|connection refused|actively refused|i\/o timeout|no route to host|no such host/i, kind: 'reconnecting' },
  { re: /try to reconnect|reconnect to server/i, kind: 'reconnecting' },
]

/**
 * @param {object} opts
 * @param {string} opts.cwd             工作目录（放 frpc.toml 的地方）
 * @param {() => {tomlPath: string, bin: string}} opts.prepare
 *        每次拉起前调用：重渲染配置并解析当前 frpc 路径（配置改了立刻生效）
 * @param {(msg: string) => void} [opts.log]  宿主日志
 * @param {number} [opts.initialDelayMs]
 * @param {number} [opts.maxDelayMs]
 */
export function createSupervisor(opts) {
  const {
    cwd,
    prepare,
    log = () => {},
    initialDelayMs = 1000,
    maxDelayMs = 60000,
    maxLogLines = DEFAULT_MAX_LOG_LINES,
    /** 仅供测试注入（默认就是 node 的 spawn）。 */
    spawnImpl = spawn,
  } = opts

  let desired = false
  let child = null
  let restartTimer = null
  let attempt = 0
  let disposed = false

  /** @type {{at: number, source: 'frpc'|'host', text: string}[]} */
  const ring = []
  let state = 'stopped'
  let lastError = ''
  let lastExit = null
  let startedAt = 0
  let connectedAt = 0
  let proxyReady = false
  let spawnCount = 0
  let fatal = ''

  const pushLog = (source, text) => {
    const clean = String(text).replace(/\r/g, '').trimEnd()
    if (clean === '') return
    for (const rawLine of clean.split('\n')) {
      const line = rawLine.slice(0, 800)
      ring.push({ at: Date.now(), source, text: line })
    }
    while (ring.length > maxLogLines) ring.shift()
  }

  const setState = (next, why) => {
    if (state === next) return
    state = next
    if (why) pushLog('host', '[' + next + '] ' + why)
    log('dsh-remote: ' + next + (why ? ' —— ' + why : ''))
  }

  /* ── pid 文件：收拾上一次的残留 ─────────────────────────────── */

  const readPid = () => {
    try {
      const raw = readFileSync(pidFilePath(), 'utf8').trim()
      const pid = Number(raw)
      return Number.isInteger(pid) && pid > 1 ? pid : null
    } catch { return null }
  }
  const writePid = (pid) => {
    try { writeFileSync(pidFilePath(), String(pid), 'utf8') } catch { /* 写不进就算了，不影响主流程 */ }
  }
  const clearPid = () => {
    try { rmSync(pidFilePath(), { force: true }) } catch { /* 同上 */ }
  }

  const alive = (pid) => {
    try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
  }

  /** 那个 pid 到底是不是 frpc（防止 pid 被系统复用后误杀别的进程）。 */
  const looksLikeFrpc = (pid) => {
    try {
      if (process.platform === 'win32') {
        const r = spawnSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
        return /frpc/i.test(r.stdout || '')
      }
      const comm = readFileSync('/proc/' + pid + '/comm', 'utf8')
      return /frpc/i.test(comm)
    } catch { return false }
  }

  const killTree = (pid) => {
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 })
      } else {
        try { process.kill(pid, 'SIGTERM') } catch { /* 已经没了 */ }
        setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch { /* 已经没了 */ } }, 1500).unref?.()
      }
    } catch { /* 杀不掉就算了，下一次 start 还会再试 */ }
  }

  /** 上一次没退干净的 frpc：先收掉，否则它会和新进程抢同一个 remotePort。 */
  const cleanupStale = () => {
    const pid = readPid()
    if (pid === null) return
    if (alive(pid) && looksLikeFrpc(pid)) {
      pushLog('host', '发现上一次残留的 frpc（pid ' + pid + '），先收掉')
      killTree(pid)
      try { rmSync(pidFilePath(), { force: true }) } catch { /* 忽略 */ }
      return
    }
    clearPid()
  }

  /**
   * 用同一份 toml 的残留 frpc（上次崩溃、或重复启动留下的）。
   * 它们抢着 bind remotePort，新进程就会报 "port already used" —— 于是表现为
   * 「状态 connected 但公网 502/一直 proxy-error」。起之前先扫掉。
   */
  let sweptThisStart = false
  /** 端口被占的自愈重试次数（每次成功连上清零）。 */
  let proxyConflictRetries = 0
  const sweepStrays = (tomlPath) => {
    if (process.platform !== 'win32' || !tomlPath) return
    try {
      const needle = tomlPath.replace(/'/g, "''")
      const script =
        "Get-CimInstance Win32_Process -Filter \"Name='frpc.exe'\" | " +
        "Where-Object { $_.CommandLine -and $_.CommandLine.Contains('" + needle + "') } | " +
        "ForEach-Object { $_.ProcessId }"
      const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8', windowsHide: true, timeout: 8000,
      })
      const pids = String(r?.stdout || '')
        .split(/\s+/).map((x) => Number(x))
        .filter((n) => Number.isInteger(n) && n > 0)
      for (const pid of pids) {
        if (child?.pid === pid) continue
        pushLog('host', '清扫残留 frpc（pid ' + pid + '，用的是同一份 toml）')
        killTree(pid)
      }
    } catch { /* 扫不掉就算了，交给 proxy-error 的提示 */ }
  }

  /* ── 拉起 / 收掉 ────────────────────────────────────────────── */

  const spawnOnce = () => {
    restartTimer = null
    if (disposed || !desired) return
    if (fatal !== '') { setState('error', fatal); return }

    let tomlPath
    let binPath
    try {
      const prepared = prepare()
      tomlPath = prepared.tomlPath
      binPath = prepared.bin
    } catch (e) {
      fatal = '渲染 frpc.toml 失败：' + String(e?.message || e)
      setState('error', fatal)
      return
    }
    if (!binPath || !existsSync(binPath)) {
      fatal = 'frpc 不存在：' + (binPath || '(未配置)')
      setState('bin-missing', fatal)
      return
    }

    if (!sweptThisStart) { sweptThisStart = true; sweepStrays(tomlPath) }

    setState('starting', attempt === 0 ? '启动 frpc' : '第 ' + attempt + ' 次重试')
    spawnCount += 1

    let proc
    try {
      proc = spawnImpl(binPath, ['-c', tomlPath], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env },
      })
    } catch (e) {
      fatal = '拉不起 frpc：' + String(e?.message || e)
      setState('spawn-error', fatal)
      return
    }

    child = proc
    startedAt = Date.now()
    connectedAt = 0
    proxyReady = false
    if (proc.pid) writePid(proc.pid)

    const onChunk = (source) => (buf) => {
      const text = String(buf)
      pushLog(source, text)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue
        for (const p of PATTERNS) {
          if (!p.re.test(line)) continue
          if (p.kind === 'connected') {
            proxyConflictRetries = 0
            if (connectedAt === 0) connectedAt = Date.now()
            setState('connected', 'login to server success')
            // 成功连上并稳定一会儿就把退避档位清掉
            setTimeout(() => { if (state === 'connected') attempt = 0 }, 20000).unref?.()
          } else if (p.kind === 'proxy') {
            proxyReady = true
            pushLog('host', '代理已建立：' + basename(binPath) + ' → remotePort 就绪')
          } else if (p.kind === 'auth-error') {
            lastError = line.trim().slice(0, 400)
            setState('auth-error', lastError)
          } else if (p.kind === 'proxy-error') {
            lastError = line.trim().slice(0, 400)
            // 「端口被占」几乎总是上一次没退干净的 frpc 还攥着 remotePort
            // （dsh 崩溃 / 重启应用时最容易发生）。这时不能就此躺平：
            // 扫掉残留、把自己这个也重启一次，重试两轮再认命。
            const portBusy = /port already used|proxy .* already (?:used|exists)/i.test(line)
            if (portBusy && proxyConflictRetries < 2 && child !== null) {
              proxyConflictRetries += 1
              pushLog('host', 'remotePort 被占：清扫残留 frpc 后重试（第 ' + proxyConflictRetries + ' 次）')
              setState('reconnecting', '端口被占，清扫后重试')
              try { sweepStrays(tomlPath) } catch { /* 扫不掉就继续试 */ }
              try { child.kill('SIGKILL') } catch { /* 让它自己退，exit 会触发重启 */ }
            } else {
              setState('proxy-error', lastError)
            }
          } else if (p.kind === 'reconnecting') {
            setState('reconnecting', line.trim().slice(0, 200))
          }
          break
        }
      }
    }

    proc.stdout?.on('data', onChunk('frpc'))
    proc.stderr?.on('data', onChunk('frpc'))

    proc.on('error', (e) => {
      fatal = 'frpc 进程报错：' + String(e?.message || e)
      pushLog('host', fatal)
      setState('spawn-error', fatal)
    })

    proc.on('exit', (code, signal) => {
      const ranMs = Date.now() - startedAt
      lastExit = { code, signal, at: Date.now(), ranMs }
      child = null
      clearPid()
      pushLog('host', 'frpc 退出（code=' + code + ', signal=' + signal + '，跑了 ' + Math.round(ranMs / 1000) + 's）')
      if (disposed || !desired) { setState('stopped', '已按要求停止'); return }
      if (state === 'auth-error' || state === 'proxy-error') {
        // 认证/端口这类配置错误，重启也没用 —— 停下来等人改配置
        setState('error', '配置问题，停止自动重试（改完配置再 start）')
        return
      }
      scheduleRestart(ranMs)
    })
  }

  const scheduleRestart = (ranMs) => {
    if (disposed || !desired) return
    if (ranMs > 60000) attempt = 0 // 稳定跑过一分钟，退避归零
    attempt += 1
    const base = Math.min(initialDelayMs * Math.pow(2, Math.max(0, attempt - 1)), maxDelayMs)
    const jitter = 0.85 + Math.random() * 0.3
    const delay = Math.round(base * jitter)
    setState('backoff', delay + 'ms 后重拉')
    restartTimer = setTimeout(spawnOnce, delay)
    restartTimer.unref?.()
  }

  /* ── 对外 API ───────────────────────────────────────────────── */

  const start = () => {
    desired = true
    fatal = ''
    attempt = 0
    if (child !== null) return { started: true, already: true }
    if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null }
    cleanupStale()
    spawnOnce()
    return { started: state === 'starting' || state === 'connected', state }
  }

  const stop = (why) => {
    desired = false
    if (restartTimer !== null) { clearTimeout(restartTimer); restartTimer = null }
    const proc = child
    if (proc) {
      const pid = proc.pid
      child = null
      killTree(pid)
    }
    clearPid()
    setState('stopped', why || '手动停止')
    return { stopped: true }
  }

  const restart = (why) => {
    stop(why || '重启')
    start()
    return { restarted: true, state }
  }

  /** 等到"连上"或"确定失败"，用于工具里给出人话结果。 */
  const waitForOutcome = (timeoutMs = 15000) => new Promise((resolve) => {
    const startedWaiting = Date.now()
    const tick = () => {
      if (state === 'connected' || state === 'stopped' || state === 'bin-missing' || state === 'spawn-error' || state === 'error' || state === 'auth-error' || state === 'proxy-error') {
        resolve({ state, waitedMs: Date.now() - startedWaiting })
        return
      }
      if (Date.now() - startedWaiting >= timeoutMs) { resolve({ state, waitedMs: Date.now() - startedWaiting, timeout: true }); return }
      setTimeout(tick, 150)
    }
    tick()
  })

  const dispose = () => {
    disposed = true
    stop('dsh 退出，收掉隧道')
  }

  const snapshot = (extra = {}) => ({
    state,
    running: child !== null,
    pid: child?.pid ?? null,
    fatal,
    lastError,
    lastExit,
    startedAt: startedAt || null,
    connectedAt: connectedAt || null,
    uptimeMs: startedAt ? Date.now() - startedAt : 0,
    proxyReady,
    spawnCount,
    backoffAttempt: attempt,
    log: ring.slice(),
    ...extra,
  })

  return { start, stop, restart, dispose, waitForOutcome, snapshot, isRunning: () => child !== null, getState: () => state, pushLog }
}