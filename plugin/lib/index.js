/**
 * dsh-remote —— host 半端：把"终端里的 dsh 连到服务器"这件事收进插件里
 * ============================================================================
 * 老方案（scripts/windows/）在 PC 上铺了五样东西：
 *   frpc.toml / start-frpc-hidden.vbs / register-pc-tasks.ps1 / 计划任务 / 手动 curl 验收
 * 这个插件把**隧道那一段**整个接过来：
 *
 *   1. 按 config.json 渲染 frpc.toml（不再手改模板，也不会忘了改 remotePort）；
 *   2. 用 windowsHide 的子进程跑 frpc —— **没有黑窗口，也不用 VBS**；
 *   3. dsh 一起来就自启隧道（顶替"登录时启动"的计划任务），dsh 退出就收掉；
 *   4. 断线按指数退避重拉；认证/端口这类配置错误则停下等人，不无限撞墙；
 *   5. 状态、日志、启停、体检都做成工具（模型能查）和回环 HTTP 接口（人/界面能查）；
 *   6. 体检会**真的**用公网 Host 探一次本地，把 403（缺 --trusted-host）和
 *      502（隧道通但 DSH 没起）分开报 —— 这两种在手机上长得一模一样。
 *
 * 配置放在 $DSH_HOME/dsh-remote/config.json（0600），不写进包目录。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

import { loadHostDeps } from './hostdeps.js'
import { findFrpc, frpcVersion, installHint, writeFrpcToml } from './frpc.js'
import {
  loadConfig, saveConfig, maskConfig, resolveToken,
  publicHostOf, publicUrlOf, trustedHostsOf,
} from './config.js'
import { configPath, frpcTomlPath, stateDir } from './paths.js'
import { createSupervisor } from './supervisor.js'
import { diagnose, probeFence, probeListener, probePublic } from './trust.js'

/** 插件行名（= cordis.patch.yml 里的 id，设置页按它找这一行）。 */
export const name = 'dsh-remote'

/** 不强制任何服务：工具、HTTP 接口、webStartup 都是**可选**加的，缺了插件照常跑。 */
export const inject = []

const CONFIG_KEYS = new Set([
  'enabled', 'autoStart', 'pcName', 'baseDomain', 'serverAddr', 'serverPort',
  'remotePort', 'localPort', 'token', 'frpcPath', 'trustedHosts', 'logLevel',
  'restartInitialMs', 'restartMaxMs',
])

/** 改了这些字段必须重拉隧道（frpc 的配置是启动时读一次的）。 */
const RESTART_KEYS = new Set(['pcName', 'baseDomain', 'serverAddr', 'serverPort', 'remotePort', 'localPort', 'token', 'logLevel'])

export function apply(ctx, _rowConfig) {
  const logger = (() => {
    try {
      const l = typeof ctx.logger === 'function' ? ctx.logger('dsh-remote') : ctx.logger
      return l && typeof l.info === 'function' ? l : undefined
    } catch { return undefined }
  })()
  const log = (msg) => { try { logger?.info?.(String(msg)) } catch { /* 日志失败不能影响隧道 */ } }

  mkdirSync(stateDir(), { recursive: true })

  /* ── 状态 ─────────────────────────────────────────────────── */

  const state = {
    loaded: loadConfig(),
    cfg: null,
    runtime: { port: undefined, host: undefined, trustedHosts: [], startup: null, detectedPort: 0, renderedPort: 0 },
    lastCheck: null,
  }
  state.cfg = state.loaded.config

  /** 按当前配置渲染 frpc.toml（启动前、以及配置齐了之后都走这里）。 */
  function renderNow() {
    const { token } = resolveToken(state.cfg)
    const port = effectiveLocalPort()
    state.runtime.renderedPort = port
    return writeFrpcToml({ ...state.cfg, localPort: port }, token)
  }

  const supervise = createSupervisor({
    cwd: stateDir(),
    prepare: () => ({ tomlPath: renderNow(), bin: findFrpc(state.cfg).path }),
    log,
    initialDelayMs: state.cfg.restartInitialMs,
    maxDelayMs: state.cfg.restartMaxMs,
  })

  /** frpc 要指向的本地端口：拿得到真实监听端口就以它为准（用户 --port 改了也对得上）。 */
  function effectiveLocalPort() {
    // ⚠️ 桌面版的端口是**启动那一刻**才定的：注入时读一次拿到的是 undefined，
    //    所以这里每次都要重新读那个活对象，不能只信注入时的快照。
    const live = state.runtime.startup?.port
    if (Number.isInteger(live) && live > 0) return live
    const detected = state.runtime.detectedPort
    if (Number.isInteger(detected) && detected > 0) return detected
    const runtimePort = state.runtime.port
    if (Number.isInteger(runtimePort) && runtimePort > 0) return runtimePort
    return state.cfg.localPort
  }

  /**
   * 我们自己的 web 端口：插件就跑在 dsh 进程里，所以「本 PID 的监听端口」就是它。
   * 桌面版不经过 webStartup 那条 CLI 路径，只能这么问操作系统。
   */
  function detectOwnPort() {
    if (process.platform !== 'win32') return 0
    try {
      const r = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
      const pid = process.pid
      const ports = []
      for (const line of String(r?.stdout || '').split(/\r?\n/)) {
        if (!line.includes('LISTENING')) continue
        const cols = line.trim().split(/\s+/)
        if (cols.length < 5) continue
        if (Number(cols[4]) !== pid) continue
        const m = /:(\d+)$/.exec(cols[1])
        if (m) {
          const p = Number(m[1])
          if (Number.isInteger(p) && p > 0 && p < 65536) ports.push(p)
        }
      }
      if (ports.length === 0) return 0
      if (ports.length > 1) {
        // 一般只有 web 端口在听；真有多个就取最大的那个（其余是内部短连接）
        ports.sort((x, y) => x - y)
        log('本进程有多个监听端口：' + ports.join(', ') + '，先按 ' + ports[ports.length - 1] + ' 试')
      }
      return ports[ports.length - 1]
    } catch {
      return 0
    }
  }

  /**
   * 真实端口和 toml 里写的对不上 → 重排 frpc.toml 并重启隧道。
   * （桌面版每次启动端口都可能变，不改就必然 502。）
   */
  function syncLocalPort() {
    // 每次都重新问一遍（端口可能在 dsh 重启后变）
    const detected = detectOwnPort()
    if (detected > 0) state.runtime.detectedPort = detected
    const live = state.runtime.startup?.port > 0 ? state.runtime.startup.port : state.runtime.detectedPort
    if (!Number.isInteger(live) || live <= 0) return false
    const rendered = state.runtime.renderedPort
    if (rendered === live) return false
    if (!supervise.isRunning()) return false
    log('本机端口是 ' + live + '，但隧道还指着 ' + (rendered || '(未渲染)') + '：重排并重启 frpc')
    try {
      renderNow()
      supervise.restart()
      return true
    } catch (e) {
      log('按新端口重排失败：' + String(e?.message || e))
      return false
    }
  }

  /** 重新读盘上的 config.json（工具/接口改完都走这里，一次只有一个真相）。 */
  function reload(reason) {
    const loaded = loadConfig()
    state.loaded = loaded
    state.cfg = loaded.config
    if (reason) log('配置已重新读取（' + reason + '）')
    return loaded
  }

  /* ── 体检 ─────────────────────────────────────────────────── */

  async function health({ deep = false } = {}) {
    const cfg = state.cfg
    const port = effectiveLocalPort()
    const host = publicHostOf(cfg)
    const listener = await probeListener(port)
    const fence = host !== '' && listener.listening
      ? await probeFence({ port, host })
      : { status: null, fence: 'unknown', error: host === '' ? '还没配 pcName/baseDomain' : '本地端口没在听' }
    const publicProbe = deep && host !== '' ? await probePublic(publicUrlOf(cfg)) : null
    const verdict = diagnose({ listener, fence, publicProbe, cfg, publicHost: host })
    state.lastCheck = { at: Date.now(), listener, fence, publicProbe, verdict }
    return { listener, fence, publicProbe, ...verdict }
  }

  /* ── 状态快照 ─────────────────────────────────────────────── */

  async function status({ deep = false, light = false, logTail = 20 } = {}) {
    const cfg = state.cfg
    const bin = findFrpc(cfg)
    const version = frpcVersion(bin.path)
    syncLocalPort()
    const snap = supervise.snapshot()
    // light：设置页每 8 秒轮询一次，不能每次都体检（那等于在自己身上再发几轮 HTTP）
    const healthResult = light
      ? { level: 'unknown', hints: [], listener: null, fence: null, publicProbe: null }
      : await health({ deep })
    const host = publicHostOf(cfg)
    const complete = state.loaded.complete === true && resolveToken(cfg).token !== ''
    const binExists = bin.path !== '' && existsSync(bin.path)

    // 体检只看"本机 dsh 好不好"不够 —— 隧道没跑也要算进去，否则"一切 ok"会骗人
    let level = healthResult.level === 'unknown' ? 'ok' : healthResult.level
    const hints = [...healthResult.hints]
    const tunnelUp = snap.state === 'connected' || snap.state === 'starting' || snap.state === 'reconnecting'
    if (complete && !binExists) {
      if (level === 'ok') level = 'error'
      hints.push('frpc 不在这台电脑上：' + (bin.path || '(未配置)'))
    } else if (complete && !tunnelUp) {
      if (level === 'ok') level = 'error'
      hints.push('隧道没在跑（' + snap.state + '）：让模型调 dsh_remote_control start，或看下面 tunnel.log')
    }

    const runtimeHosts = state.runtime.trustedHosts || []
    const missingHosts = runtimeHosts.length === 0 ? [] : trustedHostsOf(cfg).filter((h) => !runtimeHosts.includes(h))

    return {
      ok: level === 'ok' && complete,
      configured: complete,
      issues: (state.loaded.issues || []).map((i) => i.field + ': ' + i.message),
      config: maskConfig(cfg),
      publicHost: host,
      publicUrl: publicUrlOf(cfg),
      expectedTrustedHosts: trustedHostsOf(cfg),
      runtimeTrustedHosts: state.runtime.trustedHosts,
      localPort: effectiveLocalPort(),
      frpc: { path: bin.path, source: bin.source, exists: bin.path !== '' && existsSync(bin.path), version: version.version, versionError: version.error },
      tunnel: {
        state: snap.state,
        running: snap.running,
        pid: snap.pid,
        uptimeMs: snap.uptimeMs,
        connectedAt: snap.connectedAt,
        proxyReady: snap.proxyReady,
        spawnCount: snap.spawnCount,
        backoffAttempt: snap.backoffAttempt,
        lastExit: snap.lastExit,
        fatal: snap.fatal,
        lastError: snap.lastError,
        log: snap.log.slice(-Math.max(1, Math.min(logTail, 200))).map((l) => new Date(l.at).toISOString().slice(11, 19) + ' ' + l.text),
      },
      health: {
        level,
        hints,
        missingTrustedHosts: missingHosts,
        listener: healthResult.listener,
        fence: healthResult.fence,
        publicProbe: healthResult.publicProbe,
      },
      files: { config: configPath(), toml: frpcTomlPath() },
      hint: binExists ? undefined : installHint(),
    }
  }

  /* ── 控制 ─────────────────────────────────────────────────── */

  async function control(action, { wait = false } = {}) {
    const cfg = state.cfg
    if (cfg.enabled === false && (action === 'start' || action === 'restart')) {
      return { ok: false, action, error: '插件被停用了（config.enabled=false）。先改配置再启动。' }
    }
    if (action === 'start') {
      const token = resolveToken(cfg).token
      if (token === '') return { ok: false, action, error: '还没填 token：用 dsh_remote_configure 写进去' }
      const bin = findFrpc(cfg)
      if (!bin.path || !existsSync(bin.path)) return { ok: false, action, error: installHint() }
      supervise.start()
      if (wait) await supervise.waitForOutcome(15000)
      return { ok: true, action, tunnel: supervise.getState() }
    }
    if (action === 'stop') {
      supervise.stop('工具/接口要求停止')
      return { ok: true, action, tunnel: supervise.getState() }
    }
    if (action === 'restart') {
      supervise.restart('工具/接口要求重启')
      if (wait) await supervise.waitForOutcome(15000)
      return { ok: true, action, tunnel: supervise.getState() }
    }
    if (action === 'check') {
      const healthResult = await health({ deep: true })
      return { ok: healthResult.level !== 'error', action, health: { level: healthResult.level, hints: healthResult.hints, listener: healthResult.listener, fence: healthResult.fence, publicProbe: healthResult.publicProbe }, tunnel: supervise.getState() }
    }
    return { ok: false, action, error: '未知动作：' + action + '（可用 start / stop / restart / check）' }
  }

  /* ── 配置 ─────────────────────────────────────────────────── */

  function configure(patch, { restart = true } = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, error: 'patch 必须是一个对象，例如 {"pcName":"pc-a","remotePort":13080}' }
    }
    const unknown = Object.keys(patch).filter((k) => !CONFIG_KEYS.has(k))
    if (unknown.length > 0) return { ok: false, error: '不认识的字段：' + unknown.join(', ') + '（可用：' + [...CONFIG_KEYS].join(', ') + '）' }

    const merged = { ...state.cfg, ...patch }
    const needsRestart = restart && Object.keys(patch).some((k) => RESTART_KEYS.has(k))
    const saved = saveConfig(merged)
    reload('configure')

    let restarted = false
    if (needsRestart && supervise.isRunning()) {
      supervise.restart('配置变了')
      restarted = true
    }
    if (state.cfg.autoStart && state.loaded.complete && !supervise.isRunning() && state.cfg.enabled) {
      supervise.start()
      restarted = true
    }
    return {
      ok: true,
      restarted,
      config: maskConfig(state.cfg),
      issues: saved.issues.map((i) => i.field + ': ' + i.message),
      complete: saved.complete,
      tunnel: supervise.getState(),
    }
  }

  /* ── 对外：工具（可选，拿不到 tools 服务就跳过） ───────────── */

  const textOutput = {
    schema: { type: 'object', properties: {}, additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
  }
  const safe = (v) => {
    if (v === undefined || v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
    try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
  }

  let toolsReady = false
  ctx.inject(['tools'], (scope) => {
    if (toolsReady) return
    toolsReady = true
    loadHostDeps().then(({ defineTool, notes }) => {
      for (const n of notes) log(n)
      const tool = (spec) => scope.tools.register(defineTool({ ...spec, output: textOutput, async execute(args, exec) { return safe(await spec.execute(args ?? {}, exec)) } }))

      tool({
        name: 'dsh_remote_status',
        description:
          '看这台电脑的「远程接入」现状：frpc 隧道进程、最近日志、公网域名、以及本机 DSH 的 Host 信任围栏有没有放行。\n'
          + '手机上打不开时先看它：health.level=error 时 hints 里就是该改的那一条。\n'
          + 'deep=true 会真的从这台电脑探一次公网入口（慢几秒，但能分清「隧道通」和「DSH 没起」）。',
        parameters: {
          deep: { type: 'boolean', description: '额外探一次公网入口（默认 false）' },
          logTail: { type: 'number', description: '带回多少行 frpc 日志（默认 20，最多 200）' },
        },
        async execute(args) {
          return await status({ deep: args.deep === true, logTail: Number(args.logTail) || 20 })
        },
      })

      tool({
        name: 'dsh_remote_control',
        description:
          '启停 frpc 隧道。action：start / stop / restart / check。\n'
          + 'check 会做一次完整体检（含公网探测），不改变进程状态。\n'
          + '注意：隧道是「这台电脑 → 服务器 7000」的连接，停掉不影响本机 127.0.0.1 上的 dsh 本身。',
        parameters: {
          action: { type: 'string', required: true, description: 'start / stop / restart / check' },
          wait: { type: 'boolean', description: '等到连上（最多 15 秒）再返回，默认 false' },
        },
        async execute(args) {
          const action = String(args.action || '').toLowerCase()
          return await control(action, { wait: args.wait === true })
        },
      })

      tool({
        name: 'dsh_remote_configure',
        description:
          '改这台电脑的远程接入配置（合并写入 $DSH_HOME/dsh-remote/config.json，0600）。\n'
          + '必填项：pcName、baseDomain、serverAddr、remotePort（服务器 add-pc.sh 打印的那个）、token。\n'
          + '改到连接相关字段会自动重拉隧道；配置不全时不会启动，先把 issues 补完。',
        parameters: {
          patch: { type: 'json', required: true, description: '要合并的字段对象，例如 {"pcName":"pc-a","baseDomain":"example.com","serverAddr":"1.2.3.4","remotePort":13080,"token":"..."}' },
          restart: { type: 'boolean', description: '连接相关字段变了就重拉隧道（默认 true）' },
        },
        async execute(args) {
          return configure(args.patch, { restart: args.restart !== false })
        },
      })
    }).catch((e) => log('工具注册失败（不影响隧道）：' + String(e?.message || e)))
  })

  /* ── 带令牌的公网地址（只给本机设置页看） ─────────────────── */

  /**
   * dsh 每次启动都会随机生成一个 launch token，只打印在启动日志里。
   * 桌面版没人看得到那行日志，所以直接用 dsh 自己的 connection.authenticatedUrl()
   * 把它拼出来 —— 这样"远程怎么登录"就不用主人去翻任何东西了。
   *
   * ⚠️ 这是敏感值：只走本机回环接口（设置页），不进工具输出、不写盘、不进日志。
   */
  let connectionService = null
  function accessUrl() {
    const base = publicUrlOf(state.cfg)
    if (!base) return { ok: false, error: '还没配 pcName/baseDomain，算不出公网地址' }
    try {
      const fn = connectionService?.authenticatedUrl
      if (typeof fn !== 'function') {
        return {
          ok: false,
          error: '这个 dsh 没提供 connection 服务，拿不到启动令牌；请用它启动时打印的那个地址',
        }
      }
      const url = fn.call(connectionService, base)
      if (typeof url === 'string' && url !== '') return { ok: true, url }
      return { ok: false, error: 'connection 服务没有返回地址' }
    } catch (e) {
      return { ok: false, error: String(e?.message || e) }
    }
  }

  /* ── 对外：回环 HTTP 接口（给界面/脚本用） ────────────────── */

  const json = (res, code, value) => {
    const body = JSON.stringify(value, null, 2)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  /**
   * 只认「本机、且 Host 也是本机」的请求。
   *
   * ⚠️ 只看 socket 地址是不够的：隧道上来的时候，frpc 在本机转发，
   * 连接对 dsh 而言**同样是 127.0.0.1**。真正能区分"是不是远端来的"是 Host 头
   * （远端一定是 pc-a.example.com 这种）。所以两个都要查。
   */
  const isLoopback = (req) => {
    const addr = req.socket?.remoteAddress || ''
    if (!(addr === '::1' || addr === '127.0.0.1' || addr.startsWith('::ffff:127.'))) return false
    const raw = String(req.headers?.host || '').toLowerCase().trim()
    if (raw === '') return true
    const authority = raw.replace(/^\[/, '').replace(/\].*$/, '').replace(/:\d+$/, '')
    return authority === 'localhost' || authority === '::1' || /^127\./.test(authority)
  }
  const readJson = (req, limit = 128 * 1024) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('请求体太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      if (chunks.length === 0) { resolve({}); return }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch (e) { reject(new Error('不是合法 JSON：' + String(e?.message || e))) }
    })
    req.on('error', reject)
  })

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-remote/status',
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method ?? 'GET') !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const q = req.url || ''
        const deep = /[?&]deep=1\b/.test(q)
        const light = /[?&]light=1\b/.test(q)
        const value = await status({ deep, light })
        json(res, 200, { ok: true, value })
      },
    }), 'dsh-remote: status bridge')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-remote/control',
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method ?? 'GET') !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const result = await control(String(body.action || '').toLowerCase(), { wait: body.wait === true })
          json(res, 200, { ok: true, value: result })
        } catch (e) {
          json(res, 400, { ok: false, error: String(e?.message || e) })
        }
      },
    }), 'dsh-remote: control bridge')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-remote/config',
      handler: async (req, res) => {
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'loopback only' })
        const method = req.method ?? 'GET'
        if (method === 'GET') {
          json(res, 200, { ok: true, value: { config: maskConfig(state.cfg), issues: (state.loaded.issues || []).map((i) => i.field + ': ' + i.message), complete: state.loaded.complete === true } })
          return
        }
        if (method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
        try {
          const body = await readJson(req)
          const result = configure(body.patch ?? body, { restart: body.restart !== false })
          json(res, 200, { ok: true, value: result })
        } catch (e) {
          json(res, 400, { ok: false, error: String(e?.message || e) })
        }
        return undefined
      },
    }), 'dsh-remote: config bridge')

    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: '/api/dsh-remote/access-url',
      handler: (req, res) => {
        // 这里会吐出带令牌的地址：只认本机 + 本机 Host，隧道那头一律 403
        if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'loopback only' })
        if ((req.method ?? 'GET') !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        json(res, 200, { ok: true, value: accessUrl() })
        return undefined
      },
    }), 'dsh-remote: access url bridge')
  })

  /* ── 启动令牌（有 connection 服务才算得出带 token 的地址） ── */

  ctx.inject(['connection'], (scope) => {
    try { connectionService = scope.connection ?? null } catch { /* 没有就退化成提示 */ }
  })

  /* ── 真实监听端口（有 webStartup 就以它为准） ─────────────── */

  ctx.inject(['webStartup'], (scope) => {
    try {
      const startup = scope.webStartup
      if (startup && typeof startup === 'object') {
        state.runtime.startup = startup
        if (Number.isInteger(startup.port)) state.runtime.port = startup.port
        if (typeof startup.host === 'string') state.runtime.host = startup.host
        if (Array.isArray(startup.trustedHosts)) state.runtime.trustedHosts = [...startup.trustedHosts]
        const host = publicHostOf(state.cfg)
        if (host !== '' && state.runtime.trustedHosts.length > 0 && !state.runtime.trustedHosts.includes(host)) {
          log('启动参数里没写 --trusted-host ' + host + '：公网访问会 403（dsh_remote_status 的 hints 会再说一遍）')
        }
      }
    } catch { /* 拿不到就按配置里的端口来 */ }
  })

  /* ── 端口校时器 ─────────────────────────────────────────────── */

  // 桌面版要等 web 服务起来才知道端口，而 frpc 通常已经先起来了：
  // 前 60 秒每 2 秒校一次，一旦 toml 里的端口和真实端口对上就停。
  let syncTimer = null
  let syncTries = 0
  const startPortSync = () => {
    if (syncTimer !== null) return
    syncTimer = setInterval(() => {
      syncTries += 1
      syncLocalPort()
      const live = state.runtime.startup?.port > 0 ? state.runtime.startup.port : state.runtime.detectedPort
      const matched = Number.isInteger(live) && live > 0 && state.runtime.renderedPort === live
      if (matched || syncTries >= 30) {
        clearInterval(syncTimer)
        syncTimer = null
      }
    }, 2000)
    syncTimer.unref?.()
  }
  startPortSync()

  /* ── 生命周期 ─────────────────────────────────────────────── */

  ctx.effect(() => () => {
    if (syncTimer !== null) { clearInterval(syncTimer); syncTimer = null }
    try { supervise.dispose() } catch { /* 收摊失败不影响退出 */ }
  }, 'dsh-remote: 收掉 frpc 隧道')

  // 配置齐了就把 toml 先落盘：出问题时可以直接打开看，也方便老脚本复用
  if (state.loaded.complete === true) {
    try {
      const tomlPath = renderNow()
      log('已按配置渲染 frpc.toml：' + tomlPath)
    } catch (e) {
      log('渲染 frpc.toml 失败（不影响 dsh 本身）：' + String(e?.message || e))
    }
  }

  // 自启：dsh 一起来就把隧道拉起来（顶替"登录时启动"的计划任务）
  if (state.cfg.enabled === false) {
    log('插件停用中（enabled=false）：不启动隧道')
  } else if (state.loaded.complete !== true) {
    log('配置还不全，先不自动启动隧道：' + (state.loaded.issues || []).map((i) => i.field).filter((v, i, a) => a.indexOf(v) === i).join(', '))
  } else if (state.cfg.autoStart === false) {
    log('autoStart=false：不自动启动（需要时用 dsh_remote_control start）')
  } else {
    const bin = findFrpc(state.cfg)
    if (!bin.path || !existsSync(bin.path)) {
      log('找不到 frpc，先不自动启动：' + installHint().split('\n')[1])
    } else {
      log('自启隧道：' + bin.path + ' → ' + state.cfg.serverAddr + ':' + state.cfg.serverPort + ' / remotePort ' + state.cfg.remotePort)
      supervise.start()
    }
  }
}