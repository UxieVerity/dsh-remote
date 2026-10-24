/**
 * lib/config.js —— 配置的读写、校验与派生值
 * ============================================================================
 * 一份 `config.json` 就是这台电脑"连到服务器"的全部信息。规则刻意跟老脚本
 * `scripts/windows/New-DshClient.ps1` 对齐 —— 从前脚本会替你挡掉的坏值，
 * 现在由这里挡，报错文案也照抄，免得换了实现就各自为政。
 *
 * ⚠️ token 可以放两处：
 *   1. `config.json` 的 `token` 字段（简单）；
 *   2. `$DSH_HOME/dsh-remote/frp-token` 文件（0600，不想让 token 进 JSON 的人用）。
 *   文件存在时优先用文件 —— 这样 `config.json` 可以放心给人看/贴进 issue。
 * ============================================================================
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { stateDir, configPath, tokenFilePath } from './paths.js'

/** 默认值：没配过的人看到的就是这一份。 */
export function defaultConfig() {
  return {
    version: 1,
    enabled: true,
    autoStart: true,
    pcName: '',
    baseDomain: '',
    serverAddr: '',
    serverPort: 7000,
    remotePort: null,
    localPort: 3080,
    token: '',
    frpcPath: '',
    trustedHosts: [],
    logLevel: 'info',
    restartInitialMs: 1000,
    restartMaxMs: 60000,
  }
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/
const HOST_LIKE = /^[A-Za-z0-9.:-]+$/
const DOMAIN_LIKE = /^[A-Za-z0-9.-]+$/

/**
 * 校验并归一化。**不抛错**，把问题都收进 issues 里 —— 配置写坏了也要能进设置页改，
 * 而不是让整条插件加载失败。
 * @returns {{ config: object, issues: {field: string, message: string}[], complete: boolean }}
 */
export function normalizeConfig(raw) {
  const base = defaultConfig()
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const cfg = { ...base }
  const issues = []

  const str = (key, fallback) => {
    const v = input[key]
    if (v === undefined || v === null) return fallback
    if (typeof v !== 'string') { issues.push({ field: key, message: key + ' 必须是字符串' }); return fallback }
    return v.trim()
  }
  const num = (key, fallback) => {
    const v = input[key]
    if (v === undefined || v === null || v === '') return fallback
    const n = Number(v)
    if (!Number.isFinite(n)) { issues.push({ field: key, message: key + ' 必须是数字' }); return fallback }
    return n
  }
  const bool = (key, fallback) => {
    const v = input[key]
    if (v === undefined || v === null) return fallback
    if (typeof v !== 'boolean') { issues.push({ field: key, message: key + ' 必须是布尔值' }); return fallback }
    return v
  }

  cfg.enabled = bool('enabled', base.enabled)
  cfg.autoStart = bool('autoStart', base.autoStart)
  cfg.pcName = str('pcName', base.pcName).toLowerCase()
  cfg.baseDomain = str('baseDomain', base.baseDomain)
  cfg.serverAddr = str('serverAddr', base.serverAddr)
  cfg.token = typeof input.token === 'string' ? input.token.trim() : ''
  cfg.frpcPath = str('frpcPath', base.frpcPath)
  cfg.serverPort = num('serverPort', base.serverPort)
  cfg.remotePort = num('remotePort', base.remotePort)
  cfg.localPort = num('localPort', base.localPort)
  cfg.restartInitialMs = num('restartInitialMs', base.restartInitialMs)
  cfg.restartMaxMs = num('restartMaxMs', base.restartMaxMs)

  if (typeof input.logLevel === 'string') {
    const lv = input.logLevel.trim().toLowerCase()
    cfg.logLevel = ['trace', 'debug', 'info', 'warn', 'error'].includes(lv) ? lv : base.logLevel
    if (cfg.logLevel !== lv) issues.push({ field: 'logLevel', message: 'logLevel 只能是 trace/debug/info/warn/error，已用 info' })
  }

  const extraHosts = Array.isArray(input.trustedHosts) ? input.trustedHosts : []
  cfg.trustedHosts = []
  for (const h of extraHosts) {
    if (typeof h !== 'string') continue
    const v = h.trim()
    if (v === '') continue
    if (!HOST_LIKE.test(v)) { issues.push({ field: 'trustedHosts', message: 'trustedHosts 里 ' + JSON.stringify(v) + ' 不是 host[:port] 形式，已忽略' }); continue }
    if (!cfg.trustedHosts.includes(v)) cfg.trustedHosts.push(v)
  }

  // ── 现场校验（文案跟老脚本一致，出问题的人能对上号） ──
  if (cfg.pcName !== '' && !DNS_LABEL.test(cfg.pcName)) {
    issues.push({ field: 'pcName', message: 'pcName 必须是小写 DNS 标签（1-63 位，字母/数字/连字符，首尾不能是连字符）' })
  }
  if (cfg.baseDomain !== '' && (!DOMAIN_LIKE.test(cfg.baseDomain) || cfg.baseDomain.startsWith('.') || cfg.baseDomain.endsWith('.'))) {
    issues.push({ field: 'baseDomain', message: 'baseDomain 必须是裸域名后缀，例如 example.com（不带 www./尾点）' })
  }
  if (cfg.serverAddr !== '' && !HOST_LIKE.test(cfg.serverAddr)) {
    issues.push({ field: 'serverAddr', message: 'serverAddr 必须是主机名或 IP 字面量' })
  }
  if (!Number.isInteger(cfg.serverPort) || cfg.serverPort < 1 || cfg.serverPort > 65535) {
    issues.push({ field: 'serverPort', message: 'serverPort 必须在 1-65535 之间' })
  }
  if (cfg.remotePort !== null) {
    if (!Number.isInteger(cfg.remotePort) || cfg.remotePort < 13080 || cfg.remotePort > 65535) {
      issues.push({ field: 'remotePort', message: 'remotePort 必须在 13080-65535 之间（用服务器上 add-pc.sh 打印的那个）' })
    }
  }
  if (!Number.isInteger(cfg.localPort) || cfg.localPort < 1 || cfg.localPort > 65535) {
    issues.push({ field: 'localPort', message: 'localPort 必须在 1-65535 之间' })
  }
  if (cfg.restartInitialMs < 200) issues.push({ field: 'restartInitialMs', message: 'restartInitialMs 至少 200 毫秒，已按 200 处理' })
  cfg.restartInitialMs = Math.max(200, Math.min(cfg.restartInitialMs, 600000))
  cfg.restartMaxMs = Math.max(cfg.restartInitialMs, Math.min(cfg.restartMaxMs, 3600000))

  // token 只做"能不能用"的硬检查，长度/引号规则跟老脚本一致
  if (cfg.token !== '') {
    if (cfg.token.length < 32) issues.push({ field: 'token', message: 'token 至少 32 个字符（推荐 64 位十六进制）' })
    if (cfg.token.includes('"')) issues.push({ field: 'token', message: 'token 不能包含双引号' })
  }

  const required = []
  if (cfg.pcName === '') required.push('pcName')
  if (cfg.baseDomain === '') required.push('baseDomain')
  if (cfg.serverAddr === '') required.push('serverAddr')
  if (cfg.remotePort === null) required.push('remotePort')
  if (resolveTokenFileExists() ? false : cfg.token === '') required.push('token')
  for (const f of required) issues.push({ field: f, message: f + ' 还没填' })

  const blocking = issues.filter((i) => i.field !== 'logLevel' && i.field !== 'trustedHosts' && !i.message.includes('已按') && !i.message.includes('已用') && !i.message.includes('已忽略'))
  return { config: cfg, issues, complete: blocking.length === 0 }
}

function resolveTokenFileExists() {
  try { return existsSync(tokenFilePath()) } catch { return false }
}

/** 这次真正要用的 token：文件优先，其次 config.json 里的值。 */
export function resolveToken(cfg) {
  try {
    if (existsSync(tokenFilePath())) {
      const t = readFileSync(tokenFilePath(), 'utf8').trim()
      if (t !== '') return { token: t, source: 'file' }
    }
  } catch { /* 读不了就退回配置里的值 */ }
  return { token: cfg?.token || '', source: cfg?.token ? 'config' : 'none' }
}

/** 对外展示用的配置：token 永远只露"有没有"。 */
export function maskConfig(cfg) {
  const { token, ...rest } = cfg
  const resolved = resolveToken(cfg)
  return {
    ...rest,
    tokenSet: resolved.token !== '',
    tokenSource: resolved.source,
  }
}

/** 这次部署要认的 Host（含端口两种写法：老构建的浏览器信任路径两种都查）。 */
export function trustedHostsOf(cfg) {
  const host = publicHostOf(cfg)
  const out = []
  if (host !== '') {
    out.push(host)
    out.push(host + ':443')
  }
  for (const h of cfg.trustedHosts || []) if (!out.includes(h)) out.push(h)
  return out
}

export function publicHostOf(cfg) {
  if (!cfg?.pcName || !cfg?.baseDomain) return ''
  return cfg.pcName + '.' + cfg.baseDomain
}

export function publicUrlOf(cfg) {
  const host = publicHostOf(cfg)
  return host === '' ? '' : 'https://' + host + '/'
}

/** 读配置；文件不存在/坏掉都返回默认值 + 一个 note，绝不抛。 */
export function loadConfig() {
  const notes = []
  try {
    if (!existsSync(configPath())) return { config: normalizeConfig(defaultConfig()).config, raw: defaultConfig(), notes: ['还没有配置文件（第一次用）'] }
    const text = readFileSync(configPath(), 'utf8')
    const raw = JSON.parse(text)
    const { config, issues, complete } = normalizeConfig(raw)
    for (const i of issues) notes.push(i.field + ': ' + i.message)
    return { config, raw, issues, complete, notes }
  } catch (e) {
    notes.push('配置文件读不动（' + (e?.message || e) + '），按默认值处理')
    return { config: normalizeConfig(defaultConfig()).config, raw: defaultConfig(), notes }
  }
}

/** 原子写：先写 .tmp 再 rename，权限尽量收成 0600。 */
export function saveConfig(next) {
  const { config, issues, complete } = normalizeConfig(next)
  mkdirSync(stateDir(), { recursive: true })
  const file = configPath()
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  try { chmodSync(tmp, 0o600) } catch { /* Windows 上 chmod 只是尽力而为 */ }
  renameSync(tmp, file)
  try { chmodSync(file, 0o600) } catch { /* 同上 */ }
  return { config, issues, complete }
}

/** 把配置里密钥类的字段从内存里抹掉，用于日志。 */
export function scrub(text, cfg) {
  const { token } = resolveToken(cfg)
  let out = String(text ?? '')
  if (token && token.length >= 8) out = out.split(token).join('***')
  return out
}

/** 删掉配置文件（"我不玩了"的退出通道）。 */
export function removeConfig() {
  try { rmSync(configPath(), { force: true }) } catch { /* 没有就算了 */ }
}
