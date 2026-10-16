#!/usr/bin/env node
/**
 * DSH 自带 runtime 的路径推导 —— patch.mjs 与 venv.mjs 共用。
 *
 * 为什么不硬编码：体检发现两个脚本写死了 `C:/Users/Kayle/...` 和
 * `D:/DeepSeek Harness/...`，换一台机器（或换个用户名）直接失灵。
 * 推导顺序：
 *   1. HARNESS_ROOT 环境变量 —— boot-guard 脚本族的既有约定；
 *   2. process.execPath 反推 —— 脚本被 DSH 自带 node 跑时，execPath 落在
 *      <安装根>/resources/runtime/... 下，可以唯一反推出安装根；
 *   3. 都不中返回 undefined，调用方走各自的兜底（PATH 上的 pnpm / --python 报错）。
 * 每一步都用「<root>/resources 真实存在」校验，不盲信。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

function rootLooksReal(root) {
  return typeof root === 'string' && root !== '' && fs.existsSync(path.join(root, 'resources'))
}

/** DSH 安装根（含 resources/ 的那一层目录）。推导不出返回 undefined。 */
export function harnessRoot() {
  const fromEnv = process.env.HARNESS_ROOT
  if (fromEnv && rootLooksReal(fromEnv)) return fromEnv
  const marker = `${path.sep}resources${path.sep}runtime${path.sep}`
  const exe = process.execPath
  const at = exe.toLowerCase().lastIndexOf(marker.toLowerCase())
  if (at > 0) {
    const root = exe.slice(0, at)
    if (rootLooksReal(root)) return root
  }
  return undefined
}

/** DSH 自带的 pnpm.cjs；推导不出或文件不在都返回 undefined（调用方退回 PATH 的 pnpm）。 */
export function bundledPnpm() {
  const root = harnessRoot()
  if (root === undefined) return undefined
  const candidate = path.join(root, 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.cjs')
  return fs.existsSync(candidate) ? candidate : undefined
}

/** DSH 自带 Python 的候选列表（按优先级）。存在性由调用方逐个探测。 */
export function pythonCandidates() {
  const candidates = [
    // 数据目录里的预建 runtime（~/.dsh 与用户主目录绑定，homedir 即可推）。
    path.join(os.homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'),
  ]
  const root = harnessRoot()
  if (root !== undefined) {
    candidates.push(path.join(root, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'python', 'python.exe'))
  }
  return candidates
}
