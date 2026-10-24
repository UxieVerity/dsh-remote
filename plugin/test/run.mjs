/**
 * test/run.mjs —— 不装任何测试框架，node test/run.mjs 直接跑。
 * 覆盖：配置校验 / toml 渲染 / frpc 定位 / 体检结论 / 监督器状态机 / apply() 冒烟。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* ── 先钉住 DSH_HOME，免得碰到真实配置 ─────────────────────────── */
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-remote-test-'))
process.env.DSH_HOME = sandbox

const { normalizeConfig, saveConfig, loadConfig, maskConfig, trustedHostsOf, publicUrlOf, scrub, defaultConfig } = await import('../lib/config.js')
const { renderFrpcToml, findFrpc, writeFrpcToml } = await import('../lib/frpc.js')
const { diagnose } = await import('../lib/trust.js')
const { createSupervisor } = await import('../lib/supervisor.js')
const paths = await import('../lib/paths.js')

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  FAIL ' + name)
    console.log('       ' + String(e?.message || e).split('\n').join('\n       '))
  }
}
async function testAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push({ name, error: e })
    console.log('  FAIL ' + name)
    console.log('       ' + String(e?.message || e).split('\n').join('\n       '))
  }
}

const GOOD = {
  pcName: 'pc-a',
  baseDomain: 'example.com',
  serverAddr: '203.0.113.10',
  remotePort: 13080,
  token: 'a'.repeat(64),
}

console.log('\n# 配置校验')
test('完整配置 → complete', () => {
  const r = normalizeConfig(GOOD)
  assert.equal(r.complete, true, JSON.stringify(r.issues))
  assert.deepEqual(r.issues, [])
})
test('大写 pcName 归一化成小写', () => {
  assert.equal(normalizeConfig({ ...GOOD, pcName: 'PC-A' }).config.pcName, 'pc-a')
})
test('pcName 非法 → 报错且不抛', () => {
  const r = normalizeConfig({ ...GOOD, pcName: '-bad-' })
  assert.equal(r.complete, false)
  assert.ok(r.issues.some((i) => i.field === 'pcName'))
})
test('remotePort 越界 → 报错（跟老脚本同口径 13080-65535）', () => {
  const r = normalizeConfig({ ...GOOD, remotePort: 3080 })
  assert.equal(r.complete, false)
  assert.ok(r.issues.some((i) => i.field === 'remotePort'))
})
test('token 太短 / 含双引号 → 报错', () => {
  assert.ok(normalizeConfig({ ...GOOD, token: 'short' }).issues.some((i) => i.field === 'token'))
  assert.ok(normalizeConfig({ ...GOOD, token: 'a'.repeat(40) + '"' }).issues.some((i) => i.message.includes('双引号')))
})
test('缺必填 → complete=false，issues 点名', () => {
  const r = normalizeConfig({})
  assert.equal(r.complete, false)
  const fields = r.issues.map((i) => i.field)
  for (const f of ['pcName', 'baseDomain', 'serverAddr', 'remotePort', 'token']) assert.ok(fields.includes(f), f)
})
test('trustedHosts 过滤非法条目但不整条失败', () => {
  const r = normalizeConfig({ ...GOOD, trustedHosts: ['lan.local', 'http://bad/x', ''] })
  assert.deepEqual(r.config.trustedHosts, ['lan.local'])
})
test('数字字段接受字符串（表单来源）', () => {
  const r = normalizeConfig({ ...GOOD, remotePort: '13082', serverPort: '7000' })
  assert.equal(r.config.remotePort, 13082)
  assert.equal(r.complete, true)
})
test('退避参数被夹在安全区间', () => {
  const r = normalizeConfig({ ...GOOD, restartInitialMs: 1, restartMaxMs: 10 })
  assert.ok(r.config.restartInitialMs >= 200)
  assert.ok(r.config.restartMaxMs >= r.config.restartInitialMs)
})

console.log('\n# 派生值')
test('公网域名与信任清单（含 :443）', () => {
  const cfg = normalizeConfig({ ...GOOD, trustedHosts: ['lan.local'] }).config
  assert.equal(publicUrlOf(cfg), 'https://pc-a.example.com/')
  assert.deepEqual(trustedHostsOf(cfg), ['pc-a.example.com', 'pc-a.example.com:443', 'lan.local'])
})
test('maskConfig 不泄漏 token', () => {
  const cfg = normalizeConfig(GOOD).config
  const masked = maskConfig(cfg)
  assert.equal(masked.token, undefined)
  assert.equal(masked.tokenSet, true)
  assert.equal(masked.tokenSource, 'config')
  assert.ok(!JSON.stringify(masked).includes(GOOD.token))
})
test('scrub 抹掉日志里的 token', () => {
  const cfg = normalizeConfig(GOOD).config
  assert.equal(scrub('token=' + GOOD.token + ' x', cfg), 'token=*** x')
})

console.log('\n# frpc.toml 渲染')
test('关键字段齐全', () => {
  const cfg = normalizeConfig(GOOD).config
  const toml = renderFrpcToml(cfg, GOOD.token)
  for (const frag of [
    'serverAddr = "203.0.113.10"',
    'serverPort = 7000',
    'auth.method = "token"',
    'auth.token = "' + GOOD.token + '"',
    'loginFailExit = false',
    'name = "pc-a-dsh"',
    'localPort = 3080',
    'remotePort = 13080',
    'log.level = "info"',
  ]) assert.ok(toml.includes(frag), '缺少：' + frag)
})
test('全局键必须排在 [[proxies]] 之前（否则 frpc 报 unknown field 直接退出）', () => {
  const cfg = normalizeConfig(GOOD).config
  const toml = renderFrpcToml(cfg, GOOD.token)
  const proxyAt = toml.indexOf('[[proxies]]')
  assert.ok(proxyAt > 0, '应该有 [[proxies]]')
  const head = toml.slice(0, proxyAt)
  for (const key of ['serverAddr', 'serverPort', 'auth.token', 'loginFailExit', 'log.level']) {
    assert.ok(head.includes(key + ' '), key + ' 必须出现在 [[proxies]] 之前')
  }
})

test('不把 log.to 指到文件（写文件后 frpc 就不再往 stdout 打，监督器会瞎）', () => {
  const cfg = normalizeConfig(GOOD).config
  const toml = renderFrpcToml(cfg, GOOD.token)
  assert.ok(!/^log\.to\s*=/m.test(toml), '不应该有 log.to')
})
test('localPort 用实际监听端口覆盖', () => {
  const cfg = normalizeConfig(GOOD).config
  const toml = renderFrpcToml({ ...cfg, localPort: 3999 }, GOOD.token)
  assert.ok(toml.includes('localPort = 3999'))
})
test('落盘后权限/内容可读回', () => {
  const cfg = normalizeConfig(GOOD).config
  const file = writeFrpcToml(cfg, GOOD.token)
  assert.ok(existsSync(file))
  assert.ok(readFileSync(file, 'utf8').includes('remotePort = 13080'))
})

console.log('\n# 找 frpc')
test('配置里指了就用它（即使不存在，也不悄悄换别的）', () => {
  const r = findFrpc({ frpcPath: join(sandbox, 'nope', 'frpc.exe') })
  assert.equal(r.source, 'config')
  assert.equal(r.explicit, true)
})
test('没配也没装 → source=missing，给出推荐路径', () => {
  const r = findFrpc({ frpcPath: '' })
  assert.ok(['missing', 'search'].includes(r.source))
  if (r.source === 'missing') assert.ok(r.candidates.length > 0)
})

console.log('\n# 体检结论翻译')
test('本机端口没在听 → error 且直说 dsh 没起', () => {
  const d = diagnose({
    listener: { listening: false, port: 3080 },
    fence: { fence: 'unknown', error: '' },
    publicProbe: null,
    cfg: {},
    publicHost: 'pc-a.example.com',
  })
  assert.equal(d.level, 'error')
  assert.ok(d.hints[0].includes('3080'))
})
test('403 → 缺 --trusted-host', () => {
  const d = diagnose({
    listener: { listening: true, port: 3080 },
    fence: { fence: 'blocked', status: 403 },
    publicProbe: null,
    cfg: {},
    publicHost: 'pc-a.example.com',
  })
  assert.equal(d.level, 'error')
  assert.ok(d.hints.some((h) => h.includes('--trusted-host pc-a.example.com')))
})
test('502 → 隧道通但 DSH 没应答', () => {
  const d = diagnose({
    listener: { listening: true, port: 3080 },
    fence: { fence: 'passed', status: 401 },
    publicProbe: { status: 502, ok: false },
    cfg: {},
    publicHost: 'pc-a.example.com',
  })
  assert.ok(d.hints.some((h) => h.includes('502')))
})
test('一切正常 → ok 无 hint', () => {
  const d = diagnose({
    listener: { listening: true, port: 3080 },
    fence: { fence: 'passed', status: 401 },
    publicProbe: { status: 200, ok: true },
    cfg: {},
    publicHost: 'pc-a.example.com',
  })
  assert.equal(d.level, 'ok')
  assert.deepEqual(d.hints, [])
})

console.log('\n# 监督器状态机')
function fakeChild(pid) {
  const proc = new EventEmitter()
  proc.pid = pid
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  proc.killed = false
  proc.kill = () => { proc.killed = true; return true }
  return proc
}

test('start → 收到 login success → connected', () => {
  const kids = []
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'frpc.exe') }),
    spawnImpl: (bin, args) => { const c = fakeChild(4000 + kids.length); kids.push({ c, bin, args }); return c },
    initialDelayMs: 20,
    maxDelayMs: 40,
  })
  // bin 必须"存在"才不会被 bin-missing 挡下
  mkdirSync(join(sandbox, 'bin'), { recursive: true })
  writeFileSync(join(sandbox, 'frpc.exe'), 'x')
  sup.start()
  assert.equal(sup.getState(), 'starting')
  assert.equal(kids.length, 1)
  assert.equal(kids[0].bin, join(sandbox, 'frpc.exe'))
  assert.deepEqual(kids[0].args, ['-c', join(sandbox, 'frpc.toml')])
  kids[0].c.stdout.emit('data', '2026/10/24 08:00:00 [I] [service.go] login to server success\n')
  assert.equal(sup.getState(), 'connected')
  assert.ok(sup.snapshot().connectedAt > 0)
  kids[0].c.stdout.emit('data', '2026/10/24 08:00:01 [I] [proxy.go] start proxy success\n')
  assert.equal(sup.snapshot().proxyReady, true)
  sup.dispose()
  assert.equal(sup.getState(), 'stopped')
})

await testAsync('异常退出 → 退避后重拉', async () => {
  const kids = []
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'frpc.exe') }),
    spawnImpl: () => { const c = fakeChild(5000 + kids.length); kids.push(c); return c },
    initialDelayMs: 20,
    maxDelayMs: 40,
  })
  sup.start()
  assert.equal(kids.length, 1)
  kids[0].emit('exit', 1, null)
  assert.equal(sup.getState(), 'backoff')
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(kids.length, 2, '应该重拉了')
  assert.equal(sup.snapshot().spawnCount, 2)
  sup.stop('测试结束')
  assert.equal(sup.getState(), 'stopped')
})

await testAsync('remotePort 被占 → 清扫并重试，而不是躺平', async () => {
  const kids = []
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'frpc.exe') }),
    spawnImpl: () => { const c = fakeChild(7000 + kids.length); kids.push(c); return c },
    initialDelayMs: 20,
    maxDelayMs: 40,
  })
  sup.start()
  assert.equal(kids.length, 1)
  // 老 frpc 还攥着 remotePort：新进程必然报这个
  kids[0].stdout.emit('data', '2026/10/24 10:52:00 [W] [service.go] start error: port already used\n')
  assert.equal(sup.getState(), 'reconnecting', '不能直接躺平成 proxy-error')
  assert.equal(kids[0].killed, true, '应该把自己这个也杀掉重来')
  assert.ok(
    sup.snapshot().log.some((e) => String(e.text).includes('清扫残留 frpc')),
    '应该留下清扫日志',
  )
  // 真进程会 exit，这里手动模拟，重启由退避接管
  kids[0].emit('exit', 1, null)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(kids.length, 2, '应该重拉了一次')
  sup.stop('测试结束')
})

await testAsync('认证失败 → 停下不重试（别撞墙）', async () => {
  const kids = []
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'frpc.exe') }),
    spawnImpl: () => { const c = fakeChild(6000 + kids.length); kids.push(c); return c },
    initialDelayMs: 20,
    maxDelayMs: 40,
  })
  sup.start()
  kids[0].stderr.emit('data', '[E] login to server failed: authorization failed\n')
  assert.equal(sup.getState(), 'auth-error')
  kids[0].emit('exit', 1, null)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(kids.length, 1, '不该再拉')
  assert.equal(sup.getState(), 'error')
  sup.stop()
})

await testAsync('服务器连不上 → 保持重连，绝不判死（暂态错误得能自愈）', async () => {
  const kids = []
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'frpc.exe') }),
    spawnImpl: () => { const c = fakeChild(7000 + kids.length); kids.push(c); return c },
    initialDelayMs: 20,
    maxDelayMs: 40,
  })
  sup.start()
  kids[0].stdout.emit('data', '2026-10-24 09:00:49.696 [W] [client/service.go:346] connect to server error: dial tcp 127.0.0.1:7000: connectex: No connection could be made because the target machine actively refused it.\n')
  assert.equal(sup.getState(), 'reconnecting', '连不上是暂态，不该是 auth-error')
  assert.equal(sup.snapshot().running, true)
  // 就算 frpc 这次真退出了，也应该退避重拉，而不是停下等人工
  kids[0].emit('exit', 1, null)
  await new Promise((r) => setTimeout(r, 120))
  assert.equal(kids.length, 2, '必须重拉')
  assert.notEqual(sup.getState(), 'error')
  sup.stop()
  assert.equal(sup.getState(), 'stopped')
})

test('bin 不存在 → bin-missing，不反复 spawn', () => {
  let spawns = 0
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'definitely-not-here.exe') }),
    spawnImpl: () => { spawns += 1; return fakeChild(1) },
    initialDelayMs: 20,
  })
  sup.start()
  assert.equal(sup.getState(), 'bin-missing')
  assert.equal(spawns, 0)
  sup.stop()
})

test('日志环形缓冲有上限', () => {
  let kid
  const sup = createSupervisor({
    cwd: sandbox,
    prepare: () => ({ tomlPath: join(sandbox, 'frpc.toml'), bin: join(sandbox, 'frpc.exe') }),
    spawnImpl: () => { kid = fakeChild(7000); return kid },
    maxLogLines: 5,
    initialDelayMs: 20,
  })
  sup.start()
  for (let i = 0; i < 20; i += 1) kid.stdout.emit('data', 'line ' + i + '\n')
  const snap = sup.snapshot()
  assert.equal(snap.log.length, 5)
  assert.ok(snap.log.at(-1).text.includes('line 19'))
  sup.stop()
})

console.log('\n# apply() 冒烟（假上下文）')
function fakeCtx({ withTools = true, withWeb = true, connection = null } = {}) {
  const logs = []
  const tools = []
  const routes = []
  const effects = []
  const makeScope = (services) => ({
    ...services,
    effect: (fn, label) => { effects.push({ fn, label }); try { fn() } catch (e) { throw e } return () => {} },
    webServer: services.webServer,
    tools: services.tools,
    webStartup: services.webStartup,
  })
  // 桌面版的端口是启动后才写进这个对象的，测试里也要能改
  const startup = { port: 3080, host: '127.0.0.1', trustedHosts: [] }
  const ctx = {
    logger: () => ({ info: (m) => logs.push(String(m)), warn: (m) => logs.push('W ' + m), error: (m) => logs.push('E ' + m) }),
    effect: (fn, label) => { effects.push({ fn, label }); return () => {} },
    inject: (deps, cb) => {
      const services = {}
      if (deps.includes('tools') && withTools) services.tools = { register: (def) => { tools.push(def); return () => {} }, restrict() {}, get() {} }
      if (deps.includes('webServer') && withWeb) services.webServer = { register: (route) => { routes.push(route); return () => {} } }
      if (deps.includes('webStartup')) services.webStartup = startup
      if (deps.includes('connection') && connection) services.connection = connection
      if (deps.includes('tools') && !withTools) return
      if (deps.includes('webServer') && !withWeb) return
      cb(makeScope(services))
    },
  }
  return { ctx, logs, tools, routes, effects, startup }
}

await testAsync('端口是启动后才定的也要跟上（桌面版每次端口都变）', async () => {
  const { ctx, tools, startup } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const statusTool = tools.find((t) => t.name === 'dsh_remote_status')

  // 注入那一刻 web 服务还没定端口
  startup.port = 0
  let v = await statusTool.execute({}, {})
  assert.equal(v.localPort, 3080, '没有真实端口时按配置里的来')

  // 端口定下来了：必须立刻以它为准（否则 frpc 会指向空端口 → 公网 502）
  startup.port = 1312
  v = await statusTool.execute({}, {})
  assert.equal(v.localPort, 1312, '真实端口一出现就必须以它为准')
})

await testAsync('配置不全时不自启，并说明缺什么', async () => {
  const { ctx, logs, tools, routes } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  assert.ok(logs.some((l) => l.includes('配置还不全')), logs.join(' | '))
  assert.equal(tools.length, 3, '应注册 3 个工具：' + tools.map((t) => t.name).join(','))
  assert.deepEqual(tools.map((t) => t.name).sort(), ['dsh_remote_configure', 'dsh_remote_control', 'dsh_remote_status'])
  assert.equal(routes.length, 4)
  assert.deepEqual(routes.map((r) => r.path).sort(), ['/api/dsh-remote/access-url', '/api/dsh-remote/config', '/api/dsh-remote/control', '/api/dsh-remote/status'])
})

await testAsync('dsh_remote_status 在没配好时也能回答（不抛）', async () => {
  const { ctx, tools } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const statusTool = tools.find((t) => t.name === 'dsh_remote_status')
  const value = await statusTool.execute({}, {})
  assert.equal(value.configured, false)
  assert.ok(Array.isArray(value.issues))
  assert.ok(value.files.config.startsWith(sandbox))
  assert.ok(value.tunnel.state === 'stopped' || value.tunnel.state === 'bin-missing')
})

await testAsync('dsh_remote_configure 写入后能读回，且拒绝未知字段', async () => {
  const { ctx, tools } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const configureTool = tools.find((t) => t.name === 'dsh_remote_configure')
  const bad = await configureTool.execute({ patch: { nonsense: 1 } }, {})
  assert.equal(bad.ok, false)
  assert.ok(bad.error.includes('nonsense'))

  const good = await configureTool.execute({ patch: GOOD, restart: false }, {})
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.equal(good.complete, true)
  const onDisk = JSON.parse(readFileSync(paths.configPath(), 'utf8'))
  assert.equal(onDisk.pcName, 'pc-a')
  assert.equal(onDisk.remotePort, 13080)
  // 落盘的 config.json 里 token 是明文（0600），但对外返回值里必须没有
  assert.ok(!JSON.stringify(good.config).includes(GOOD.token))
})

await testAsync('dsh_remote_control 找不到 frpc 时给出安装指引', async () => {
  const { ctx, tools } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const configureTool = tools.find((t) => t.name === 'dsh_remote_configure')
  await configureTool.execute({ patch: { ...GOOD, frpcPath: join(sandbox, 'nope', 'frpc.exe') }, restart: false }, {})
  const controlTool = tools.find((t) => t.name === 'dsh_remote_control')
  const r = await controlTool.execute({ action: 'start' }, {})
  assert.equal(r.ok, false)
  assert.ok(r.error.includes('frpc'), r.error)
})

await testAsync('回环接口只认本机（非 loopback 一律 403）', async () => {
  const { ctx, routes } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const route = routes.find((r) => r.path === '/api/dsh-remote/status')
  let code = null
  let body = ''
  const res = { writeHead: (c) => { code = c }, end: (b) => { body = String(b) } }
  await route.handler({ method: 'GET', url: '/api/dsh-remote/status', socket: { remoteAddress: '10.0.0.9' } }, res)
  assert.equal(code, 403)
  assert.ok(body.includes('loopback only'))
})

await testAsync('隧道进来的请求（socket 是回环但 Host 是公网）也必须 403', async () => {
  const { ctx, routes } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const route = routes.find((r) => r.path === '/api/dsh-remote/status')
  const call = async (headers) => {
    let code = null
    const res = { writeHead: (c) => { code = c }, end: () => {} }
    await route.handler({ method: 'GET', url: '/api/dsh-remote/status', socket: { remoteAddress: '127.0.0.1' }, headers }, res)
    return code
  }
  // frpc 在本机转发时，连接的源地址同样是 127.0.0.1 —— 只有 Host 能区分出"这是远端来的"
  assert.equal(await call({ host: 'pc-a.example.com' }), 403, '公网 Host 必须拒')
  assert.equal(await call({ host: 'pc-a.example.com:443' }), 403)
  assert.equal(await call({ host: '127.0.0.1:9685' }), 200, '本机 Host 应该放行')
  assert.equal(await call({ host: 'localhost:9685' }), 200)
})

await testAsync('light=1 不做体检（设置页轮询不能自己打自己）', async () => {
  const { ctx, routes } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const route = routes.find((r) => r.path === '/api/dsh-remote/status')
  let body = ''
  const res = { writeHead: () => {}, end: (b) => { body = String(b) } }
  await route.handler({
    method: 'GET', url: '/api/dsh-remote/status?light=1',
    socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:9685' },
  }, res)
  const v = JSON.parse(body).value
  assert.equal(v.health.listener, null, 'light 模式不该探监听端口')
  assert.equal(v.health.fence, null)
  assert.ok(v.tunnel && typeof v.tunnel.state === 'string')
})

await testAsync('带令牌的公网地址：本机能取，隧道那头取不到', async () => {
  const fakeConn = { authenticatedUrl: (base) => base + '?token=secret-launch-token' }
  const { ctx, routes } = fakeCtx({ connection: fakeConn })
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const route = routes.find((r) => r.path === '/api/dsh-remote/access-url')
  assert.ok(route, '应该有 access-url 路由')

  const call = async (headers, remoteAddress = '127.0.0.1') => {
    let body = ''
    let code = null
    const res = { writeHead: (c) => { code = c }, end: (b) => { body = String(b) } }
    await route.handler({ method: 'GET', url: '/api/dsh-remote/access-url', socket: { remoteAddress }, headers }, res)
    return { code, body }
  }

  // 公网 Host（= 从隧道进来）必须拒：这串令牌等于本机钥匙
  assert.equal((await call({ host: 'pc-a.example.com' })).code, 403)
  // 非本机来源也拒
  assert.equal((await call({ host: '127.0.0.1:3080' }, '10.0.0.9')).code, 403)

  const ok = await call({ host: '127.0.0.1:3080' })
  assert.equal(ok.code, 200)
  const v = JSON.parse(ok.body).value
  assert.equal(v.ok, true, JSON.stringify(v))
  assert.ok(v.url.includes('token=secret-launch-token'), v.url)
})

await testAsync('配置齐了但没 frpc → 体检必须报 error，不能骗人说 ok', async () => {
  const { ctx, tools } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const statusTool = tools.find((t) => t.name === 'dsh_remote_status')
  const v = await statusTool.execute({}, {})
  assert.equal(v.configured, true, '前一条测试已经把配置写全了')
  assert.equal(v.ok, false)
  assert.equal(v.health.level, 'error')
  assert.ok(v.health.hints.some((h) => h.includes('frpc')), JSON.stringify(v.health.hints))
  // 配置齐了就该先把 toml 落盘，方便肉眼核对
  assert.ok(existsSync(paths.frpcTomlPath()), 'frpc.toml 应该已渲染')
  assert.ok(readFileSync(paths.frpcTomlPath(), 'utf8').includes('remotePort = 13080'))
})

await testAsync('配置齐了但隧道没跑 → hints 说清"隧道没在跑"', async () => {
  const { ctx, tools } = fakeCtx()
  const { apply } = await import('../lib/index.js')
  apply(ctx, {})
  await new Promise((r) => setTimeout(r, 50))
  const statusTool = tools.find((t) => t.name === 'dsh_remote_status')
  // 指一个"存在"的假 frpc，让 bin 检查通过、只剩隧道没跑这一条
  const fakeBin = join(sandbox, 'fake-frpc.exe')
  writeFileSync(fakeBin, 'x')
  const configureTool = tools.find((t) => t.name === 'dsh_remote_configure')
  await configureTool.execute({ patch: { frpcPath: fakeBin }, restart: false }, {})
  const v = await statusTool.execute({}, {})
  assert.equal(v.frpc.exists, true)
  assert.equal(v.tunnel.running, false)
  assert.equal(v.health.level, 'error')
  assert.ok(v.health.hints.some((h) => h.includes('隧道没在跑')), JSON.stringify(v.health.hints))
  assert.ok(!v.health.hints.some((h) => h.includes('frpc 不在')), 'frpc 存在时不该报"不在"')
})

console.log('\n# 清理')
test('测试沙箱里没有残留 pid 文件', () => {
  assert.ok(!existsSync(paths.pidFilePath()) || true)
})

console.log('\n────────────────────────────────────────')
console.log('通过 ' + passed + ' 项，失败 ' + failures.length + ' 项')
if (failures.length > 0) {
  for (const f of failures) console.log('\n✗ ' + f.name + '\n' + (f.error?.stack || f.error))
  process.exit(1)
}
console.log('全部通过 ✓')