/**
 * lib/trust.js —— 信任围栏与可达性的"体检"
 * ============================================================================
 * 为什么要这一份：DSH 对非回环来源的 `Host` 有一道栅栏（`connection` 行的
 * `trustedHosts`）。请求从 nginx 进来时 `Host: pc-a.example.com`，若这个
 * authority 没被信任，DSH 直接 403 —— 而 403 和"隧道没通"在手机上看起来一模一样，
 * 这是这套部署里最容易吵起来的一个点。
 *
 * 所以插件不猜，直接**按真实请求探一次**：
 *   - 给 127.0.0.1:3080 发一个 `Host: <公网域名>` 的 GET：
 *       403 → 栅栏没过（缺 --trusted-host）
 *       401 → 栅栏过了，只是没登录 ✓
 *       200 → 栅栏过了且已带 cookie ✓
 *   - 再探一次公网 URL：502 = 隧道通但 DSH 没起；连接被拒 = 隧道没通。
 * ============================================================================
 */
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

/** 本地端口在不在听（不依赖任何服务）。 */
export function probeListener(port, { host = '127.0.0.1', timeoutMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port })
    const done = (listening) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve({ listening, port, host })
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/**
 * 带着公网 Host 头打一次本地，看栅栏放不放行。
 * @returns {Promise<{status: number|null, fence: 'passed'|'blocked'|'unknown', error: string}>}
 */
export function probeFence({ port, host, path = '/', timeoutMs = 5000 }) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { Host: host, 'User-Agent': 'dsh-remote-selfcheck' } },
      (res) => {
        const status = res.statusCode ?? null
        res.resume()
        const fence = status === 403 ? 'blocked' : status === null ? 'unknown' : 'passed'
        resolve({ status, fence, error: '' })
      },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => resolve({ status: null, fence: 'unknown', error: String(e?.message || e) }))
    req.end()
  })
}

/** 从这台电脑探一次公网入口（走真实 TLS，跟手机看到的一样）。 */
export function probePublic(url, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    let target
    try { target = new URL(url) } catch (e) { resolve({ status: null, ok: false, error: 'URL 不合法：' + String(e?.message || e) }); return }
    const mod = target.protocol === 'https:' ? https : http
    const req = mod.request(
      { host: target.hostname, port: target.port || (target.protocol === 'https:' ? 443 : 80), path: target.pathname + target.search, method: 'GET', headers: { 'User-Agent': 'dsh-remote-selfcheck' } },
      (res) => {
        const status = res.statusCode ?? null
        res.resume()
        resolve({ status, ok: status !== null && status < 500, error: '' })
      },
    )
    req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')) })
    req.on('error', (e) => resolve({ status: null, ok: false, error: String(e?.code || e?.message || e) }))
    req.end()
  })
}

/** 体检结论翻译成人话（tools 和 HTTP 接口共用）。 */
export function diagnose({ listener, fence, publicProbe, cfg, publicHost }) {
  const hints = []
  let level = 'ok'

  if (!listener.listening) {
    level = 'error'
    hints.push('本机 127.0.0.1:' + listener.port + ' 没在监听 —— 终端里的 dsh 还没起来，或者 --port 不是这个值')
  }
  if (listener.listening && fence.fence === 'blocked') {
    level = 'error'
    hints.push('DSH 认不出 ' + publicHost + ' 这个 Host（403）—— 启动 dsh 时加上：--trusted-host ' + publicHost + ' --trusted-host ' + publicHost + ':443')
  } else if (listener.listening && fence.fence === 'unknown' && fence.error) {
    level = level === 'ok' ? 'warn' : level
    hints.push('栅栏探测失败（' + fence.error + '），可能只是探测方式受限，手机上试一次为准')
  }
  if (publicProbe && publicProbe.status === 502) {
    level = 'error'
    hints.push('公网返回 502 —— 隧道通了，但 DSH 那边没有应答（先看 dsh 是否还在运行）')
  } else if (publicProbe && publicProbe.status === null) {
    level = level === 'ok' ? 'warn' : level
    hints.push('公网入口没探到（' + publicProbe.error + '）—— 可能是 DNS/证书/服务器 nginx 还没配好，或者这台电脑现在没网')
  } else if (publicProbe && publicProbe.status === 403) {
    level = 'error'
    hints.push('公网 403 —— nginx 没保留真实 Host，或者 DSH 侧没信任这个 authority（两种都查一下）')
  }

  return { level, hints }
}
