// Profile / port detection — the one place that knows which environment this
// install is running as.
//
// 上游 guard 是 web 版出身的：默认 profile 硬编码 'web'、默认端口硬编码 3080、
// 守护脚本拉起的是 `dsh.cmd web`。桌面端（Electron 壳跑 dsh-desktop-host）这三
// 条全不成立：profile 叫 desktop、端口由宿主启动参数给定（本机 19387）、启动
// 方式是 `DeepSeek Harness.exe`。这里把判断收成一处，宿主半、CLI、守护脚本
// 共用，谁也不再写死。
//
// 探测优先级（越靠前越权威）：
//   profile: DSH_GUARD_PROFILE → DSH_PROFILE_DIR 的目录名 → profiles/desktop
//            → profiles/web → 第一个 profile → 'desktop'
//   port:    DSH_GUARD_PORT → guard/config.json 里显式写的 port → DEFAULT_PORT
import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { profilesDir } from './layout.js'

/** 桌面端宿主默认端口（dsh-desktop-host 的 runProfile 参数）。 */
export const DEFAULT_PORT = 19387
/** web 版（`dsh web`）默认端口，仅作回退。 */
export const LEGACY_WEB_PORT = 3080
/** 桌面端 profile 名。 */
export const DESKTOP_PROFILE = 'desktop'
/** 上游 web 版 profile 名。 */
export const WEB_PROFILE = 'web'

function existingProfileNames() {
  const dir = profilesDir()
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('_'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

function isUsable(name) {
  return typeof name === 'string' && name !== '' && existsSync(join(profilesDir(), name))
}

/**
 * 当前生效的 profile 名。显式覆盖（env / 调用方参数）永远优先，其余靠探测。
 * @param {string} [explicit] 调用方给的 profile（CLI --profile / 工具参数）。
 * @returns {string}
 */
export function detectProfile(explicit) {
  if (isUsable(explicit)) return explicit
  if (isUsable(process.env.DSH_GUARD_PROFILE)) return process.env.DSH_GUARD_PROFILE
  const fromDir = process.env.DSH_PROFILE_DIR
  if (typeof fromDir === 'string' && fromDir !== '' && isUsable(basename(fromDir))) return basename(fromDir)
  const names = existingProfileNames()
  if (names.includes(DESKTOP_PROFILE)) return DESKTOP_PROFILE
  if (names.includes(WEB_PROFILE)) return WEB_PROFILE
  if (names.length > 0) return names.sort()[0]
  return DESKTOP_PROFILE
}

/** 当前生效端口。显式覆盖 → 配置文件显式值 → 桌面端默认值。 */
export function detectPort(configured) {
  const fromEnv = Number(process.env.DSH_GUARD_PORT)
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
  const fromConfig = Number(configured)
  if (Number.isFinite(fromConfig) && fromConfig > 0) return fromConfig
  return DEFAULT_PORT
}

/** 候选端口列表：探测活着的那一个时按序试。 */
export function portCandidates(configured) {
  const seen = new Set()
  const out = []
  for (const p of [process.env.DSH_GUARD_PORT, configured, DEFAULT_PORT, LEGACY_WEB_PORT]) {
    const n = Number(p)
    if (Number.isFinite(n) && n > 0 && !seen.has(n)) {
      seen.add(n)
      out.push(n)
    }
  }
  return out
}
