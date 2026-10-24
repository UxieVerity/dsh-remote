/**
 * lib/hostdeps.js —— 从宿主那棵树里取 `@deepseek-ai/dsh-tools` 的 defineTool
 * ============================================================================
 * 为什么不裸 import：`dsh-tools` 在别人家插件里是 optional peer，而桌面版 profile 是
 * `autoInstallPeers: false` ⇒ 可能根本不装 ⇒ 一条裸 import 就能让**整条插件不激活**
 * （DSH 只留一句 `entry did not activate … failed to import`）。
 * 这个插件本体不需要 defineTool 也能跑，所以：
 *   ① 先按宿主可能的位置去解析；
 *   ② 再试 bare import（万一 profile 树里 hoist 上来了）；
 *   ③ 都不行 ⇒ 用本地等价实现（把 DSL 转成 JSON Schema），工具照常可用。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF_MODULES = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)
  const appdata = process.env.APPDATA
  if (appdata) {
    const npm = join(appdata, 'npm', 'node_modules')
    push(join(npm, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
    push(join(npm, '@deepseek-ai'))
  }
  push('/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai')
  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  try {
    const home = process.env.DSH_HOME || join(homedir(), '.dsh')
    for (const p of readdirSync(join(home, 'profiles'))) push(join(home, 'profiles', p, 'node_modules', '@deepseek-ai'))
  } catch { /* 没有就算了 */ }
  push(SELF_MODULES)
  return out
}

function entryUrlFor(root, name) {
  try {
    const dir = join(root, name)
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return null
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    const dot = pkg.exports?.['.']
    const rel = typeof dot === 'string' ? dot : (dot?.import || dot?.default || pkg.module || pkg.main)
    if (!rel) return null
    const file = join(dir, String(rel).replace(/^\.\//, ''))
    return existsSync(file) ? pathToFileURL(file).href : null
  } catch { return null }
}

/* ── 本地等价实现：把 defineTool 的 DSL 翻成 JSON Schema ─────────────── */

function specToJsonSchema(spec) {
  if (!spec || typeof spec !== 'object') return {}
  const out = {}
  if (spec.description) out.description = spec.description
  if (spec.default !== undefined) out.default = spec.default
  if (Array.isArray(spec.enum)) out.enum = spec.enum
  if (Array.isArray(spec.oneOf)) { out.oneOf = spec.oneOf.map(specToJsonSchema); return out }
  const type = spec.type || (spec.properties ? 'object' : undefined)
  if (type === 'json') return out // 任意 JSON
  if (type) out.type = type
  if (type === 'array') out.items = specToJsonSchema(spec.items || {})
  if (type === 'object') {
    out.properties = {}
    out.additionalProperties = spec.additionalProperties === true
    const required = []
    for (const [key, child] of Object.entries(spec.properties || {})) {
      out.properties[key] = specToJsonSchema(child)
      if (child && child.required === true) required.push(key)
    }
    if (required.length > 0) out.required = required
    if (out.additionalProperties === false && required.length === 0) delete out.required
  }
  return out
}

function localDefineTool(options) {
  return {
    ...options,
    parameters: specToJsonSchema(options.parameters),
    output: options.output
      ? { ...options.output, schema: options.output.schema ?? { type: 'object', additionalProperties: true } }
      : undefined,
  }
}

/** @returns {Promise<{defineTool: Function, notes: string[]}>} */
export async function loadHostDeps() {
  const notes = []
  const log = (m) => notes.push(m)

  for (const root of candidateRoots()) {
    if (root === SELF_MODULES) continue
    const url = entryUrlFor(root, 'dsh-tools')
    if (!url) continue
    try {
      const mod = await import(url)
      const defineTool = mod?.defineTool || mod?.default?.defineTool
      if (typeof defineTool === 'function') {
        log('defineTool：从宿主树取到（' + url.replace(/^file:\/\//, '') + '）')
        return { defineTool, notes }
      }
    } catch (e) {
      log('defineTool：宿主树里这一份 import 失败（' + (e?.code || e?.message || 'ERR') + '），换下一个')
    }
  }
  try {
    const mod = await import('@deepseek-ai/dsh-tools')
    const defineTool = mod?.defineTool || mod?.default?.defineTool
    if (typeof defineTool === 'function') {
      log('defineTool：用自己树里那份')
      return { defineTool, notes }
    }
  } catch {
    /* 没装，正常 */
  }
  log('defineTool：宿主和自己都没有 —— 用本地等价实现（工具照常可用）')
  return { defineTool: localDefineTool, notes }
}
