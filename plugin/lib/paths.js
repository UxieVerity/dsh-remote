/**
 * lib/paths.js —— 插件在用户机器上的落脚点
 * ============================================================================
 * 全部落在 `$DSH_HOME/dsh-remote/`，**不写进插件包目录**（包目录可能只读、也可能被
 * `pnpm` 覆写；DSH 各家插件都是这个惯例）。
 *
 *   $DSH_HOME/dsh-remote/
 *     config.json      本插件的配置（0600，可能含 frp token）
 *     frp-token        可选的 token 文件（0600）—— 不想把 token 写进 config.json 的人用
 *     frpc.toml        每次启动前按配置渲染出来的隧道配置（0600）
 *     frpc.pid         当前隧道的 pid，用来收拾上一次残留的进程
 *     bin/frpc.exe     推荐把 frpc 放这里（也可以配 frpcPath 指到别处）
 * ============================================================================
 */
import os from 'node:os'
import path from 'node:path'

/** DSH 家目录：尊重 DSH_HOME，否则退回 ~/.dsh（跟宿主一致）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  return path.join(os.homedir(), '.dsh')
}

/** 本插件的状态目录。 */
export function stateDir() {
  return path.join(dshHome(), 'dsh-remote')
}

export function configPath() {
  return path.join(stateDir(), 'config.json')
}

export function tokenFilePath() {
  return path.join(stateDir(), 'frp-token')
}

export function frpcTomlPath() {
  return path.join(stateDir(), 'frpc.toml')
}

export function frpcLogPath() {
  return path.join(stateDir(), 'frpc.log')
}

export function pidFilePath() {
  return path.join(stateDir(), 'frpc.pid')
}

/** frpc 的推荐放置位置，按优先级排。 */
export function frpcSearchPaths() {
  const list = [path.join(stateDir(), 'bin', 'frpc.exe')]
  if (process.platform === 'win32') {
    // 老方案（scripts/windows）留下的位置，装了插件也不用挪
    list.push('C:\\dsh-relay\\frpc.exe')
    list.push(path.join(stateDir(), 'bin', 'frpc'))
  } else {
    list.push(path.join(stateDir(), 'bin', 'frpc'))
    list.push('/usr/local/bin/frpc')
    list.push('/usr/bin/frpc')
  }
  return list
}