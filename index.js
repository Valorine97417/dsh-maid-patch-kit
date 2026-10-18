/**
 * dsh-maid-patch-kit —— 给社区插件打**不阻碍上游更新**的维护补丁，并盯着它别掉。
 *
 * 为什么不 fork：fork 出去就分家了，上游每发一版都得手工 rebase，久了就成
 * 一具自己的尸体。这里走的是 pnpm patch——补丁正本在 `patches/`，登记在
 * profile 的 `pnpm-workspace.yaml`，hash 落进 lockfile，任何一次 install /
 * 重铺都会自动重打；上游照常升级，只是升完要跑一次 `upgrade` 把补丁重做一遍。
 *
 * 为什么必须"盯着"：这条路的每一个环节都是静默失效的。2026-10-14 实测，
 * video-understand 的七处修复手改进 `node_modules/`，随后装一个插件触发重铺，
 * 连补丁带 `.venv` 一起被抹平，回到纯原版——没有报错，直到小困再调
 * `video_understand` 才发现工具根本不在。转正成 pnpm patch 之后风险低了一个
 * 量级，但"自动"不等于"必然"：profile 换了、pnpm 版本变了、上游发新版了，
 * 都可能让它悄悄失效。
 *
 * 所以本插件在启动时做一件很便宜的事：把"登记、hash、落盘"三项问一遍，
 * 任何一项掉了就 warn 出来，附上修它的那一条命令。它不修、不拦、不抛——
 * 一个体检器没有资格让应用起不来。
 *
 * @module dsh-maid-patch-kit
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { inspectProfile, describe as describeRows, inspectDuplicates, describeDuplicates } from './lib/selfcheck.js'
import { duplicates } from './lib/targets.js'

export const name = 'patch-kit'
/** 无必需服务：纯启动自检 + 提示，不注册路由、不依赖 settings。 */
export const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 找 profile：优先宿主给的环境变量，退回 desktop 的默认落点。 */
function resolveProfile() {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0 && fs.existsSync(fromEnv)) return fromEnv
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
}

/**
 * 装配：跑一次补丁体检，有问题就 warn。
 *
 * 为什么放在 apply 而不是做成命令：这份体检的价值全在"**没人想起来的时候**
 * 它也在跑"。补丁失效是静默的，静默的故障只能靠主动巡检发现。
 *
 * @param {object} ctx cordis 上下文。
 */
export function apply(ctx) {
  const warn = (message) => {
    try { ctx.logger?.warn?.(`[${name}] ${message}`) } catch { /* 日志不是失败理由 */ }
  }
  const info = (message) => {
    try { ctx.logger?.info?.(`[${name}] ${message}`) } catch { /* 同上 */ }
  }

  // 两段体检各自独立 try：补丁那段没东西可查（patches/ 空）不该把重复层那段也带走。
  const profile = resolveProfile()

  try {
    const patchDir = path.join(HERE, 'patches')
    const { ok, rows, patches } = inspectProfile(profile, patchDir)

    if (patches.length === 0) {
      warn(`patches/ 下没有补丁正本（${patchDir}），补丁体检跳过`)
    } else if (ok) {
      info(`补丁齐备：${patches.map(p => p.base).join('、')}（profile: ${profile}）`)
    } else {
      for (const line of describeRows(rows)) warn(line)
      warn('补丁掉了就等于没修。修：node scripts/patch.mjs install，然后重启 DSH')
    }
  } catch (error) {
    warn(`补丁体检失败，跳过（不影响运行）：${error instanceof Error ? error.message : String(error)}`)
  }

  // ── 重复层：该卸的包回潮了没有 ──
  // 与补丁相反，这类故障是「静默多出来」：多出来的那个不报错，只是把活抢走
  // （2026-10-14 独立 dsh-video-skin 赢下路由、2026-10-17 maid-atelier 重复注入）。
  try {
    const rows = inspectDuplicates(profile, Object.fromEntries(duplicates()))
    const lines = describeDuplicates(rows)
    if (lines.length === 0) {
      info(`重复层干净：${rows.map(row => row.packageName).join('、')} 都不在 profile 里`)
    } else {
      for (const line of lines) warn(line)
    }
  } catch (error) {
    warn(`重复层体检失败，跳过（不影响运行）：${error instanceof Error ? error.message : String(error)}`)
  }
}
