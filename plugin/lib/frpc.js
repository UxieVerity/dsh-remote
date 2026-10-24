/**
 * lib/frpc.js —— 找 frpc、渲染 frpc.toml、问版本
 * ============================================================================
 * 只做"能不能跑"的事，不碰进程（进程在 lib/supervisor.js）。
 *
 * 渲染出来的 toml 跟 `templates/frpc.toml.template` 等价 —— 老脚本生成的配置
 * 可以原样继续用，插件不另起一套格式。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { frpcSearchPaths, frpcTomlPath, stateDir } from './paths.js'

/** 把一段文本放进 TOML 基本字符串里。 */
function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n') + '"'
}

/**
 * 找 frpc 可执行文件。
 * @returns {{ path: string, source: string, candidates: string[] }}
 */
export function findFrpc(cfg) {
  const candidates = []
  const push = (p) => { if (p) candidates.push(p) }
  if (cfg?.frpcPath) {
    // 配置里给了就只认它 —— 免得"我以为用的是这个，其实用的是那个"
    const p = cfg.frpcPath
    return { path: existsSync(p) ? p : p, source: 'config', candidates: [p], explicit: true }
  }
  for (const p of frpcSearchPaths()) push(p)
  for (const p of pathLookup()) push(p)
  for (const p of candidates) {
    if (existsSync(p)) return { path: p, source: 'search', candidates }
  }
  return { path: candidates[0] || '', source: 'missing', candidates }
}

/** PATH 里找 frpc（Windows 用 where，其它用 which；找不到就算了）。 */
function pathLookup() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    const r = spawnSync(cmd, ['frpc'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    if (r.status !== 0 || !r.stdout) return []
    return r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '')
  } catch {
    return []
  }
}

/** 问一次版本（缓存结果；frpc -v 是毫秒级的）。 */
const versionCache = new Map()
export function frpcVersion(binPath) {
  if (!binPath) return { version: '', error: 'frpc 路径为空' }
  if (versionCache.has(binPath)) return versionCache.get(binPath)
  let result
  try {
    if (!existsSync(binPath)) {
      result = { version: '', error: '文件不存在：' + binPath }
    } else {
      const r = spawnSync(binPath, ['-v'], { encoding: 'utf8', windowsHide: true, timeout: 10000 })
      const text = ((r.stdout || '') + (r.stderr || '')).trim()
      const m = text.match(/\d+\.\d+\.\d+/)
      result = m ? { version: m[0], error: '' } : { version: '', error: text.slice(0, 200) || ('退出码 ' + r.status) }
    }
  } catch (e) {
    result = { version: '', error: String(e?.message || e).slice(0, 200) }
  }
  versionCache.set(binPath, result)
  return result
}

/** 按配置渲染 frpc.toml 文本（不落盘，方便单测对比）。 */
export function renderFrpcToml(cfg, token) {
  // ⚠️ 顺序很重要：所有"全局"键必须排在 [[proxies]] 之前，
  // 否则 TOML 会把它们算进代理表，frpc 报 unknown field 直接退出（踩过）。
  // 另外不要把 log.to 指到文件：一旦落到文件，frpc 就不再往 stdout 写，
  // 监督器就看不见 "login to server success" 这类关键行了。日志由环形缓冲接管。
  const lines = [
    '# frpc.toml —— 由 dsh-remote 插件按 config.json 渲染，每次启动都会重写',
    '# 手改没用：改 $DSH_HOME/dsh-remote/config.json（或让模型调 dsh_remote_configure）',
    '',
    'serverAddr = ' + tomlString(cfg.serverAddr),
    'serverPort = ' + Number(cfg.serverPort),
    '',
    'auth.method = "token"',
    'auth.token = ' + tomlString(token),
    '',
    '# 服务器偶尔不可达时继续重连，别退出（进程退出就轮到插件重启它了）',
    'loginFailExit = false',
    '',
    '# 日志走 stdout，交给插件收集（写文件会让 frpc 不再输出到控制台）',
    'log.level = ' + tomlString(cfg.logLevel || 'info'),
    '',
    '[[proxies]]',
    'name = ' + tomlString(String(cfg.pcName) + '-dsh'),
    'type = "tcp"',
    'localIP = "127.0.0.1"',
    'localPort = ' + Number(cfg.localPort),
    'remotePort = ' + Number(cfg.remotePort),
    '',
  ]
  return lines.join('\n')
}

/** 渲染并落盘（0600）。返回写到的路径。 */
export function writeFrpcToml(cfg, token) {
  mkdirSync(stateDir(), { recursive: true })
  mkdirSync(dirname(frpcTomlPath()), { recursive: true })
  const file = frpcTomlPath()
  writeFileSync(file, renderFrpcToml(cfg, token), 'utf8')
  try { chmodSync(file, 0o600) } catch { /* Windows 上尽力而为 */ }
  return file
}

/** 读回已渲染的 toml（诊断用；没有就返回空串）。 */
export function readRenderedToml() {
  try { return readFileSync(frpcTomlPath(), 'utf8') } catch { return '' }
}

/** 当前应该把 frpc.exe 放哪 —— 报错时直接告诉用户这一步。 */
export function installHint() {
  const target = join(stateDir(), 'bin', process.platform === 'win32' ? 'frpc.exe' : 'frpc')
  return [
    '没找到 frpc。两条路选一条：',
    '  1) 把 frpc 放到 ' + target + '（推荐，插件自己就会找到）',
    '  2) 在设置里把 frpcPath 指到你放 frpc 的地方',
    '版本要和服务器上的 frps 一致（本仓库测试基线 0.71.1）：',
    '  https://github.com/fatedier/frp/releases/download/v0.71.1/frp_0.71.1_windows_amd64.zip',
  ].join('\n')
}