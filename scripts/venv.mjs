#!/usr/bin/env node
/**
 * 给 dsh-video-understand 补齐它的 Python 运行时（`.venv`）。
 *
 * 为什么这也要管：`.venv` 住在**包目录内部**（`node_modules/dsh-video-understand/.venv`），
 * 所以 pnpm 重铺时会跟着包一起被删掉——补丁我们能用 pnpm patch 保住，`.venv`
 * 保不住（它不是补丁能表达的东西）。2026-10-14 那次重铺之后实测：补丁和 `.venv`
 * 一起没了，`video_understand` 直接报工具不存在。
 *
 * 好在引擎本身有懒安装（`dsh/env.mjs`：uv → python3 -m venv，走清华镜像），
 * 所以**理论上**首次调用会自动补。但那一步依赖 `python3` 这个名字，而 Windows
 * 上没有它；本地实测的出路是用 DSH 自带的 Python 3.12 预建。本脚本就干这件事：
 * 幂等地把 `.venv` 建好，省掉首次调用时的失败与等待。
 *
 * 用法：
 *   node scripts/venv.mjs            # 缺就建，有就核对
 *   node scripts/venv.mjs --force    # 删了重建
 *   node scripts/venv.mjs --verify   # 只看状态，不动手
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { pythonCandidates } from './runtime-paths.mjs'

const has = flag => process.argv.includes(flag)
function argValue(flag) {
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** 需要 venv 的包（目前只有 video-understand）。 */
const VENV_PACKAGES = Object.freeze([
  { package: 'dsh-video-understand', requirements: 'engine/requirements.txt' },
])

/**
 * DSH 自带的 Python，候选按优先级排：~/.dsh 下的预建 runtime（homedir 推导）、
 * 安装根下的 runtime（HARNESS_ROOT 环境变量或自带 node 反推，见 runtime-paths.mjs）。
 * 两个落点都试，谁在就用谁；都不在走 --python / 报错兜底。
 */
const PYTHON_CANDIDATES = pythonCandidates()

const MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'

/** 核心依赖的 import 名（与 dsh/env.mjs 的 CORE_MODS 对齐）。 */
const CORE_MODS = ['faster_whisper', 'cv2', 'yt_dlp']

function resolveProfile() {
  const explicit = argValue('--profile')
  if (explicit !== undefined) return path.resolve(explicit)
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && fs.existsSync(fromEnv)) return fromEnv
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
}

function findPython() {
  const explicit = argValue('--python')
  if (explicit !== undefined) return explicit
  return PYTHON_CANDIDATES.find(candidate => fs.existsSync(candidate))
}

/** venv 里的解释器（Windows 是 Scripts，POSIX 是 bin）。 */
function venvPython(venvDir) {
  const win = path.join(venvDir, 'Scripts', 'python.exe')
  if (fs.existsSync(win)) return win
  const posix = path.join(venvDir, 'bin', 'python')
  return fs.existsSync(posix) ? posix : undefined
}

/**
 * 核心依赖是否都在。
 *
 * 一次 `python -c` 把三个 import 全试掉：比开三次进程便宜，也比只查目录
 * 可靠——`.venv` 目录在而包不全（上次装到一半）是真实会发生的状态。
 */
function coreModsOk(python) {
  const code = [
    'import importlib',
    `mods = ${JSON.stringify(CORE_MODS)}`,
    'missing = []',
    'for m in mods:',
    '    try:',
    '        importlib.import_module(m)',
    '    except Exception:',
    '        missing.append(m)',
    'print("OK" if not missing else "MISSING:" + ",".join(missing))',
  ].join('\n')
  const result = spawnSync(python, ['-c', code], { encoding: 'utf8', shell: false })
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) return { ok: false, detail: out.split('\n').pop() || `退出码 ${result.status}` }
  if (out.endsWith('OK')) return { ok: true, detail: 'core ok' }
  return { ok: false, detail: out.replace(/^MISSING:/, '缺 ').replace(/,/g, '、') }
}

function run(command, args, cwd) {
  console.log(`\n$ ${path.basename(command)} ${args.join(' ')}${cwd ? `   （cwd: ${cwd}）` : ''}`)
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: false })
  if (result.error) throw result.error
  return result.status ?? 1
}

const profile = resolveProfile()
const verifyOnly = has('--verify')
const force = has('--force')

let failed = false
for (const entry of VENV_PACKAGES) {
  const root = path.join(profile, 'node_modules', entry.package)
  console.log(`\n── ${entry.package} ──`)
  if (!fs.existsSync(root)) {
    console.log(`  · 包未安装（${root}），跳过。`)
    continue
  }
  const venvDir = path.join(root, '.venv')

  if (force && fs.existsSync(venvDir)) {
    if (verifyOnly) {
      console.log('  · --verify：将删除并重建 .venv')
      continue
    }
    fs.rmSync(venvDir, { recursive: true, force: true })
    console.log('  · --force：已删除旧 .venv')
  }

  const existing = venvPython(venvDir)
  if (existing) {
    const check = coreModsOk(existing)
    if (check.ok) {
      console.log(`  ✓ .venv 就绪（${check.detail}）`)
      continue
    }
    console.log(`  ✗ .venv 在，但依赖不全：${check.detail}`)
    if (verifyOnly) { failed = true; continue }
    const status = run(existing, ['-m', 'pip', 'install', '-r', path.join(root, entry.requirements), '-i', MIRROR])
    if (status !== 0) { failed = true; console.error(`  ✗ pip 退出码 ${status}`); continue }
    const recheck = coreModsOk(existing)
    console.log(recheck.ok ? `  ✓ 补装完成（${recheck.detail}）` : `  ✗ 仍然缺：${recheck.detail}`)
    failed = failed || !recheck.ok
    continue
  }

  console.log('  · .venv 不存在（pnpm 重铺会连它一起删）')
  if (verifyOnly) { failed = true; continue }

  const python = findPython()
  if (python === undefined) {
    console.error('  ✗ 找不到 DSH 自带的 Python，用 --python <路径> 指定一个 3.9-3.13 的解释器。')
    failed = true
    continue
  }
  console.log(`  · 用 ${python} 建 venv`)

  // 先建 venv，再装依赖，分两步：venv 建失败（比如解释器被挪走）时
  // 不该白跑一遍 pip。
  if (run(python, ['-m', 'venv', venvDir]) !== 0) {
    failed = true
    console.error('  ✗ venv 创建失败')
    continue
  }
  const fresh = venvPython(venvDir)
  if (fresh === undefined) {
    failed = true
    console.error('  ✗ venv 建好了却找不到解释器')
    continue
  }
  if (run(fresh, ['-m', 'pip', 'install', '--upgrade', 'pip', '-q', '-i', MIRROR]) !== 0) {
    console.log('  · pip 自升级失败，继续装依赖（通常不影响）')
  }
  const status = run(fresh, ['-m', 'pip', 'install', '-r', path.join(root, entry.requirements), '-i', MIRROR])
  if (status !== 0) {
    failed = true
    console.error(`  ✗ pip 退出码 ${status}`)
    continue
  }
  const check = coreModsOk(fresh)
  console.log(check.ok ? `  ✓ .venv 建好（${check.detail}）` : `  ✗ 建好但仍缺：${check.detail}`)
  failed = failed || !check.ok
}

console.log(failed ? '\n有未通过项，见上。' : '\nPython 运行时齐备。')
process.exit(failed ? 1 : 0)
