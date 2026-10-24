/**
 * dsh-remote —— 浏览器半端（设置里的一页）
 * ============================================================================
 * ⭐ client bundle 不是 ESM，是**自注册脚本**（抄 dsh-bili-scroll / dsh-meme 的写法）：
 *
 *     window.__ModuleLoader__.load({
 *       id: '<package.json 的 name>',
 *       factory: (require) => ({ inject: ['slots'], apply(ctx) { ... } }),
 *     })
 *
 * ⭐ 进「设置」的正确姿势（不是自己糊标题栏按钮）：
 *
 *     slots.inject('settings.section', () => slots.register(
 *       { name: 'settings.section', id: 'dsh-remote', order: 35, label: '远程接入' },
 *       () => h(Panel),
 *     ))
 *
 * 后端接口（都在宿主进程里，且只认本机 Host）：
 *   GET  /api/dsh-remote/status[?light=1][&deep=1]
 *   POST /api/dsh-remote/control   { action: start|stop|restart|check, wait }
 *   GET  /api/dsh-remote/config
 *   POST /api/dsh-remote/config    { patch, restart }
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/dsh-remote'

    const asJson = async (res) => {
      if (res.ok) return res.json()
      if (res.status === 403) throw new Error('这个页面只能在跑 DSH 的那台电脑上打开（接口只认本机）')
      throw new Error('HTTP ' + res.status)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-dr-page]{display:flex;flex-direction:column;gap:18px;padding:2px 2px 10px;max-width:640px;}
[data-dr-sec]{display:flex;flex-direction:column;gap:9px;}
[data-dr-h]{font-size:11px;font-weight:600;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dr-row]{display:flex;align-items:center;gap:10px;}
[data-dr-grow]{flex:1;min-width:0;}
[data-dr-label]{font-size:13px;}
[data-dr-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dr-field]{display:flex;flex-direction:column;gap:4px;}
[data-dr-field]>span{font-size:12px;color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dr-field]>em{font-style:normal;font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-dr-input]{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:8px;font-size:12px;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.14));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;font-family:inherit;}
[data-dr-input]:focus{outline:none;border-color:#3b82f6;}
[data-dr-num]{width:110px;}
[data-dr-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;padding:0;}
[data-dr-sw][data-on]{background:#3b82f6;}
[data-dr-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-dr-sw][data-on] i{left:19px;}
[data-dr-btn]{padding:7px 12px;border-radius:8px;font-size:12px;cursor:pointer;font-family:inherit;
  border:1px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:inherit;}
[data-dr-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.24));}
[data-dr-btn][data-primary]{background:#3b82f6;border-color:#3b82f6;color:#fff;}
[data-dr-btn][disabled]{opacity:.5;cursor:default;}
[data-dr-msg]{font-size:11px;line-height:16px;padding:8px 10px;border-radius:8px;word-break:break-word;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dr-msg][data-warn]{color:#f59e0b;}
[data-dr-msg][data-good]{color:#22c55e;}
[data-dr-msg][data-bad]{color:#ef4444;}
[data-dr-badge]{font-size:11px;padding:2px 8px;border-radius:6px;font-family:ui-monospace,monospace;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dr-badge][data-tone=good]{background:rgba(34,197,94,.16);color:#22c55e;}
[data-dr-badge][data-tone=warn]{background:rgba(245,158,11,.16);color:#f59e0b;}
[data-dr-badge][data-tone=bad]{background:rgba(239,68,68,.16);color:#ef4444;}
[data-dr-kv]{font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary,#9aa0a6);word-break:break-all;
  font-family:ui-monospace,monospace;}
[data-dr-pre]{margin:4px 0 0;padding:8px 9px;border-radius:8px;max-height:180px;overflow:auto;font-size:11px;
  line-height:15px;white-space:pre-wrap;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.25));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-dr-grid]{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
`

    const TONE = {
      connected: 'good', starting: 'warn', reconnecting: 'warn', backoff: 'warn',
      stopped: 'warn', 'bin-missing': 'bad', 'auth-error': 'bad', 'proxy-error': 'bad',
      'spawn-error': 'bad', error: 'bad',
    }
    const STATE_TEXT = {
      stopped: '没在跑', starting: '正在启动', connected: '已连上服务器', reconnecting: '连不上，正在重试',
      backoff: '退避等待中', 'bin-missing': '找不到 frpc', 'auth-error': 'token 不对（已停止重试）',
      'proxy-error': '端口/代理冲突（已停止重试）', 'spawn-error': '拉不起 frpc', error: '出错了',
    }

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-dr-sw': '', 'data-on': on ? '' : undefined, disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function Toggle({ label, note, on, onChange, disabled }) {
      return h('div', { 'data-dr-row': '' },
        h('div', { 'data-dr-grow': '' },
          h('div', { 'data-dr-label': '' }, label),
          note ? h('div', { 'data-dr-note': '' }, note) : null),
        h(Switch, { on, onChange, disabled }))
    }

    function Field({ label, hint, value, onChange, type, placeholder, mono }) {
      return h('label', { 'data-dr-field': '' },
        h('span', null, label),
        h('input', {
          'data-dr-input': '',
          type: type || 'text',
          value: value === undefined || value === null ? '' : String(value),
          placeholder: placeholder || '',
          style: mono ? { fontFamily: 'ui-monospace,monospace' } : undefined,
          onChange: (e) => onChange(e.target.value),
        }),
        hint ? h('em', null, hint) : null)
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [token, setToken] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState(null)      // { text, tone }
      const [showLog, setShowLog] = React.useState(false)
      const [access, setAccess] = React.useState(null)   // { ok, url } | { ok:false, error }
      const [reveal, setReveal] = React.useState(false)

      const fill = (value) => {
        const c = value?.config || {}
        setForm({
          pcName: c.pcName || '',
          baseDomain: c.baseDomain || '',
          serverAddr: c.serverAddr || '',
          serverPort: c.serverPort ?? 7000,
          remotePort: c.remotePort ?? '',
          localPort: c.localPort ?? 3080,
          frpcPath: c.frpcPath || '',
          logLevel: c.logLevel || 'info',
          enabled: c.enabled !== false,
          autoStart: c.autoStart !== false,
        })
      }

      const refresh = async (deep) => {
        try {
          const r = await jget('/status' + (deep ? '?deep=1' : '?light=1'))
          setSt(r.value)
          if (!form) fill(r.value)
          return r.value
        } catch (e) {
          setMsg({ text: String(e.message || e), tone: 'bad' })
          return null
        }
      }

      React.useEffect(() => {
        let alive = true
        ;(async () => {
          const r = await jget('/status').catch((e) => { setMsg({ text: String(e.message || e), tone: 'bad' }); return null })
          if (!alive || !r) return
          setSt(r.value)
          fill(r.value)
        })()
        const t = setInterval(async () => {
          try {
            const r = await jget('/status?light=1')
            if (alive) setSt(r.value)
          } catch { /* 轮询失败就安静一点，别刷屏 */ }
        }, 8000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

      // 带令牌的地址：**点一下才去要**，不在页面加载时顺手拿
      const loadAccess = async () => {
        setBusy('access'); setAccess(null)
        try {
          const r = await jget('/access-url')
          setAccess(r.value || { ok: false, error: '接口没返回内容' })
          setReveal(false)
        } catch (e) {
          setAccess({ ok: false, error: String(e.message || e) })
        } finally { setBusy('') }
      }
      const copyUrl = async (url) => {
        try {
          await navigator.clipboard.writeText(url)
          setMsg({ text: '已复制，粘到手机浏览器打开一次就好', tone: 'good' })
        } catch {
          setMsg({ text: '复制失败，请手动选中那段地址复制', tone: 'warn' })
        }
      }

      const save = async (restart) => {
        setBusy('save'); setMsg(null)
        try {
          const patch = { ...form }
          patch.serverPort = Number(patch.serverPort) || 7000
          patch.localPort = Number(patch.localPort) || 3080
          patch.remotePort = patch.remotePort === '' ? 0 : Number(patch.remotePort)
          if (token.trim() !== '') patch.token = token.trim()
          const r = await jpost('/config', { patch, restart })
          const v = r.value || {}
          if (v.ok === false) throw new Error(v.error || '保存失败')
          setToken('')
          const issues = v.issues || []
          setMsg({
            text: issues.length
              ? '已保存，但还没配全：' + issues.join('；')
              : (v.restarted ? '已保存，隧道正在按新配置重连' : '已保存'),
            tone: issues.length ? 'warn' : 'good',
          })
          await refresh()
        } catch (e) {
          setMsg({ text: '保存失败：' + String(e.message || e), tone: 'bad' })
        } finally { setBusy('') }
      }

      const act = async (action, label) => {
        setBusy(action); setMsg(null)
        try {
          const r = await jpost('/control', { action, wait: action !== 'stop' })
          const v = r.value || {}
          if (v.ok === false) throw new Error(v.error || (label + '失败'))
          setMsg({ text: label + '：' + (v.tunnel || v.health?.level || 'ok'), tone: 'good' })
          await refresh(action === 'check')
        } catch (e) {
          setMsg({ text: label + '失败：' + String(e.message || e), tone: 'bad' })
        } finally { setBusy('') }
      }

      if (!st || !form) {
        return h('div', { 'data-dr-page': '' },
          h('div', { 'data-dr-note': '' }, '正在读取隧道状态……'),
          msg ? h('div', { 'data-dr-msg': '', 'data-bad': msg.tone === 'bad' ? '' : undefined }, msg.text) : null)
      }

      const tun = st.tunnel || {}
      const health = st.health || {}
      const tone = TONE[tun.state] || 'warn'
      const stateText = STATE_TEXT[tun.state] || tun.state || '未知'
      const issues = st.issues || []
      const hints = health.hints || []

      return h('div', { 'data-dr-page': '' },

        /* ── 现在怎么样 ── */
        h('div', { 'data-dr-sec': '' },
          h('div', { 'data-dr-h': '' }, '现在怎么样'),
          h('div', { 'data-dr-row': '' },
            h('span', { 'data-dr-badge': '', 'data-tone': tone }, stateText),
            h('span', { 'data-dr-badge': '' }, 'tunnel: ' + (tun.state || '?')),
            st.configured
              ? h('span', { 'data-dr-badge': '' }, '配置齐全')
              : h('span', { 'data-dr-badge': '', 'data-tone': 'warn' }, '配置还不全'),
            h('div', { 'data-dr-grow': '' }),
            h('button', { 'data-dr-btn': '', disabled: busy !== '', onClick: () => act('restart', '重连') }, '重连'),
            h('button', { 'data-dr-btn': '', disabled: busy !== '' || !tun.running, onClick: () => act('stop', '停止') }, '停止'),
            h('button', { 'data-dr-btn': '', disabled: busy !== '', onClick: () => act('check', '体检') }, '体检'),
            h('button', { 'data-dr-btn': '', disabled: busy !== '', onClick: () => refresh(true) }, '刷新')),
          h('div', { 'data-dr-kv': '' },
            '公网：' + (st.publicUrl || '(未配置)'),
            h('br'),
            'frpc：' + (st.frpc?.path || '(未找到)') + (st.frpc?.version ? '  v' + st.frpc.version : ''),
            h('br'),
            '状态目录：' + (st.files?.config || '')),
          issues.length
            ? h('div', { 'data-dr-msg': '', 'data-warn': '' }, '还没配好：' + issues.join('；'))
            : null,
          hints.length
            ? h('div', { 'data-dr-msg': '', 'data-warn': '' }, hints.join('\n'))
            : null,
          msg ? h('div', { 'data-dr-msg': '', 'data-good': msg.tone === 'good' ? '' : undefined, 'data-warn': msg.tone === 'warn' ? '' : undefined, 'data-bad': msg.tone === 'bad' ? '' : undefined }, msg.text) : null,
          st.hint ? h('div', { 'data-dr-msg': '' }, st.hint) : null),

        /* ── 连到哪台服务器 ── */
        h('div', { 'data-dr-sec': '' },
          h('div', { 'data-dr-h': '' }, '服务器与这台电脑'),
          h(Field, { label: '这台电脑的名字（pcName）', hint: '要和服务器上 add-pc.sh --name 一致，小写字母/数字/短横线', value: form.pcName, onChange: set('pcName'), mono: true }),
          h(Field, { label: '域名后缀（baseDomain）', hint: '裸域名，例如 example.com（不带 https://）', value: form.baseDomain, onChange: set('baseDomain'), mono: true }),
          h(Field, { label: '服务器地址（serverAddr）', hint: '公网 IP 或主机名，frpc 会主动连过去', value: form.serverAddr, onChange: set('serverAddr'), mono: true }),
          h('div', { 'data-dr-grid': '' },
            h(Field, { label: 'frps 控制端口', hint: '默认 7000', value: form.serverPort, onChange: set('serverPort'), type: 'number' }),
            h(Field, { label: '远程端口（remotePort）', hint: 'add-pc.sh 打印的那个，13080-65535', value: form.remotePort, onChange: set('remotePort'), type: 'number' })),
          h(Field, { label: '本机 dsh 端口（localPort）', hint: '一般 3080；拿到真实端口时以真实端口为准', value: form.localPort, onChange: set('localPort'), type: 'number' }),
          h(Field, {
            label: 'frp token',
            hint: st.config?.tokenSet
              ? '已设置（来源：' + (st.config.tokenSource === 'file' ? 'frp-token 文件' : 'config.json') + '），留空就不改动'
              : '还没设置。也可以把它写进 dsh-remote/frp-token 文件',
            value: token, onChange: setToken, type: 'password', placeholder: st.config?.tokenSet ? '已设置（留空不改）' : '粘 64 位 token',
          })),

        /* ── 怎么跑 ── */
        h('div', { 'data-dr-sec': '' },
          h('div', { 'data-dr-h': '' }, '怎么跑'),
          h(Toggle, { label: '启用隧道', note: '关掉之后插件不碰 frpc，但 dsh 本身照跑', on: form.enabled, onChange: set('enabled') }),
          h(Toggle, { label: '跟着 dsh 自启', note: 'dsh 一起来就把 frpc 拉起来，退出时一并收掉', on: form.autoStart, onChange: set('autoStart'), disabled: !form.enabled }),
          h(Field, { label: 'frpc 路径（可空）', hint: '留空就按「状态目录 bin → C:\\dsh-relay → PATH」找', value: form.frpcPath, onChange: set('frpcPath'), mono: true }),
          h('div', { 'data-dr-row': '' },
            h('span', { 'data-dr-label': '' }, '日志级别'),
            h('select', {
              'data-dr-input': '', style: { width: '130px' }, value: form.logLevel,
              onChange: (e) => set('logLevel')(e.target.value),
            }, ['trace', 'debug', 'info', 'warn', 'error'].map((lv) => h('option', { key: lv, value: lv }, lv)))),
          h('div', { 'data-dr-row': '' },
            h('button', { 'data-dr-btn': '', 'data-primary': '', disabled: busy !== '', onClick: () => save(true) }, '保存并重连'),
            h('button', { 'data-dr-btn': '', disabled: busy !== '', onClick: () => save(false) }, '只保存'),
            h('button', { 'data-dr-btn': '', disabled: busy !== '', onClick: () => { fill(st); setToken(''); setMsg(null) } }, '撤销改动'))),

        /* ── 远程访问要用的地址 ── */
        h('div', { 'data-dr-sec': '' },
          h('div', { 'data-dr-h': '' }, '远程访问地址'),
          h('div', { 'data-dr-note': '' },
            'dsh 每次启动都会换一个登录令牌。第一次在手机 / 外网打开时地址里要带上它，打开一次浏览器就记住了。'),
          h('div', { 'data-dr-row': '' },
            h('button', { 'data-dr-btn': '', disabled: busy !== '', onClick: loadAccess },
              access ? '重新获取' : '获取带令牌的公网地址')),
          access
            ? (access.ok
              ? h('div', { 'data-dr-sec': '' },
                h('div', { 'data-dr-kv': '', style: { fontSize: '12px' } },
                  reveal ? access.url : access.url.replace(/token=.*$/, 'token=••••••••')),
                h('div', { 'data-dr-row': '' },
                  h('button', { 'data-dr-btn': '', onClick: () => setReveal((v) => !v) }, reveal ? '隐藏' : '显示'),
                  h('button', { 'data-dr-btn': '', 'data-primary': '', onClick: () => copyUrl(access.url) }, '复制'),
                  h('span', { 'data-dr-note': '' }, '这串令牌等于本机 dsh 的钥匙，别发群里')))
              : h('div', { 'data-dr-msg': '', 'data-warn': '' }, access.error))
            : null),

        /* ── 日志 ── */
        h('div', { 'data-dr-sec': '' },
          h('div', { 'data-dr-row': '' },
            h('div', { 'data-dr-h': '' }, 'frpc 日志（最近 ' + (tun.log?.length || 0) + ' 行，只在内存里）'),
            h('div', { 'data-dr-grow': '' }),
            h('button', { 'data-dr-btn': '', onClick: () => setShowLog((v) => !v) }, showLog ? '收起' : '展开')),
          showLog
            ? h('pre', { 'data-dr-pre': '' }, (tun.log || []).map((e) => String(e.text || '').trim()).filter(Boolean).join('\n') || '(还没有日志)')
            : null),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-remote')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-remote: 设置页样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'dsh-remote', order: 35, label: '远程接入' },
          () => h(Panel),
        ))
      },
    }
  },
})