/**
 * 补丁体检 —— 纯函数，不写盘。
 *
 * 这个模块的判据与 `dsh-maid-tts-fix` 同源，伤口也一样：2026-10-14 那次，
 * video-understand 的七处修复是手改进 `node_modules/` 的，随后装一个插件触发
 * pnpm 重铺，**连补丁带 .venv 一起被抹平**，回到纯原版——没有报错，直到小困
 * 再调 `video_understand` 才发现工具根本不在。改 node_modules 等于没改。
 *
 * 转正成 pnpm patch 之后（补丁正本在 `patches/`，登记在 `pnpm-workspace.yaml`，
 * hash 进 lockfile），重铺会自动重打。但"自动"不等于"必然"：profile 换了、
 * pnpm 版本变了、补丁文件被谁动过、上游发了新版——都可能让它悄悄失效。
 *
 * 三问（缺一不可，因为它们是三个独立的失效点）：
 *   1. 登记还在吗   —— `pnpm-workspace.yaml` 的 `patchedDependencies`
 *   2. hash 对得上吗 —— lockfile 的 `patch_hash` 是不是 `.patch` 正本的 sha256
 *   3. 字节落盘了吗 —— 上游包里那些文件真的含补丁特征吗
 *
 * 第 3 问必须**逐文件**问：这里的补丁动辄跨六七个文件，只抽查一个的话，
 * 恰好漏掉没打上的那一个就白体检了。
 *
 * @module lib/selfcheck
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 补丁落盘后必然出现的特征串。
 *
 * 改补丁时同步改这里——它是"补丁在不在"的判据，不是文档。每条都挑一个
 * **只在补丁里出现**的字符串：`_gateway_config` 上游没有，`PYTHONUTF8` 上游没有，
 * BOM 上游也没有。挑得太泛（比如 `def download`）就会在未打补丁的包上误报。
 */
export const APPLIED_MARKERS = Object.freeze([
  // ── dsh-video-understand@0.5.2 ──
  // dsh/index.js：三处改动各验一条。第一条不能写 `type: 'string'` —— 原版里
  // 本来就有 18 处，用它当判据会在没打补丁的包上误报"已应用"。带上前缀
  // `upgrade_layer: { ` 才唯一（原版那行是 `type: ['string', 'null']`）。
  { package: 'dsh-video-understand', file: 'dsh/index.js', marker: "upgrade_layer: { type: 'string' }" },
  { package: 'dsh-video-understand', file: 'dsh/index.js', marker: 'PYTHONUTF8' },
  { package: 'dsh-video-understand', file: 'dsh/index.js', marker: 'typeof parsed.video' },
  { package: 'dsh-video-understand', file: 'engine/understand_video.py', marker: '_gateway_config' },
  { package: 'dsh-video-understand', file: 'engine/understand_video.py', marker: 'bv*[height<=360]+ba' },
  { package: 'dsh-video-understand', file: 'engine/stages.py', marker: '_gateway_config' },
  { package: 'dsh-video-understand', file: 'engine/visual_level.py', marker: '_gateway_config' },
  { package: 'dsh-video-understand', file: 'engine/avis.py', marker: '_utf8_run' },
  // BOM 用码位写，别写成 \uFEFF 之外的转义：读出来就是文件首字符。
  { package: 'dsh-video-understand', file: 'engine/requirements.txt', marker: '\uFEFF# d' },
  { package: 'dsh-video-understand', file: 'engine/requirements.txt', marker: 'pandas>=2.0' },
  { package: 'dsh-video-understand', file: 'engine/requirements-layer.txt', marker: '\uFEFF# d' },
  // ── dsh-ego-browser@0.8.6 ──
  { package: 'dsh-ego-browser', file: 'runtime/ego-linux/src/chrome.mjs', marker: 'killWindowsProfileOwners' },
  // lib/client.js 的侧边栏实时面板配色：原版是 macOS 灰蓝（#0a84ff / #30d158 /
  // rgba(128,128,128,…)），补丁换成与 maid-atelier 深海女仆皮肤同源的柔金 #c5a468。
  // 挑 `--ego-gold` 与 `--ego-ink`（原版没有这两个自定义属性）当判据。
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: '--ego-gold' },
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: '--ego-ink' },
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: 'dsh-ego-side-head::after' },
  // 面板顶边不再自绘蕾丝，改为复用 maid-atelier 皮肤注入到 body 的素材变量
  // （左侧栏那条金蕾丝弧带 + 深蓝蝴蝶结）。原版 client.js 里 `maid-sidebar` 出现 0 次，
  // 故这串是安全的唯一判据。
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: '--maid-sidebar-swag-art' },
  // 面板底边收口（--maid-bottom-trim-art 绒边 + --maid-bottom-crest-art 徽章）与
  // 空态中央立绘（皮肤静态路由 /skin-assets/maid-atelier/<hash>.webp）。
  // 判据挑 `maid-bottom` 前缀与静态路由前缀——原版两串均为 0 次。
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: '--maid-bottom-trim-art' },
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: '/skin-assets/maid-atelier/' },
  { package: 'dsh-ego-browser', file: 'lib/client.js', marker: 'dsh-ego-side-empty::before' },
])

/** 本仓带的所有补丁：`patches/<包名>@<版本>.patch`。 */
export function listPatches(patchDir) {
  if (!fs.existsSync(patchDir)) return []
  return fs.readdirSync(patchDir)
    .filter(name => name.endsWith('.patch'))
    .sort()
    .map(name => {
      const file = path.join(patchDir, name)
      const base = name.replace(/\.patch$/, '')
      const at = base.lastIndexOf('@')
      const content = fs.readFileSync(file)
      return {
        name,
        file,
        base,
        packageName: at < 0 ? base : base.slice(0, at),
        version: at < 0 ? '' : base.slice(at + 1),
        bytes: content.length,
        sha256: crypto.createHash('sha256').update(content).digest('hex'),
      }
    })
}

/** lockfile 里记的 `patch_hash`（同一键会出现多次，取第一个即可）。 */
export function lockPatchHash(lockText, packageName, version) {
  if (typeof lockText !== 'string') return undefined
  const escaped = `${packageName}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = lockText.match(new RegExp(`^\\s+${escaped}:\\s+([0-9a-f]{64})\\s*$`, 'm'))
  return match ? match[1] : undefined
}

/** `pnpm-workspace.yaml` 的 `patchedDependencies` 里有没有这条登记。 */
export function isRegistered(workspaceText, packageName, version) {
  if (typeof workspaceText !== 'string') return false
  const escaped = `${packageName}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s+${escaped}\\s*:\\s*\\S+`, 'm').test(workspaceText)
}

/** 某个上游包目录里，属于它的补丁特征是否都在。 */
export function inspectApplied(packageRoot, packageName) {
  return APPLIED_MARKERS
    .filter(item => item.package === packageName)
    .map(({ file, marker }) => {
      const target = path.join(packageRoot, file)
      if (!fs.existsSync(target)) return { file, marker, state: 'missing-file' }
      const text = fs.readFileSync(target, 'utf8')
      return { file, marker, state: text.includes(marker) ? 'applied' : 'not-applied' }
    })
}

/** profile 里实际装的上游版本（读它的 package.json）。读不到返回 undefined。 */
export function installedVersion(packageRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 对一个 profile 做全套体检。
 *
 * 只读文件、不抛异常：任何读不到的路径都折成 `false` 与一句人话，
 * 因为调用它的人（启动自检）没有资格让应用起不来。
 *
 * @param {string} profile DSH profile 目录。
 * @param {string} patchDir 补丁正本目录。
 * @returns {{ ok: boolean, rows: Array<object>, patches: Array<object> }}
 */
export function inspectProfile(profile, patchDir) {
  const patches = listPatches(patchDir)
  const workspaceFile = path.join(profile, 'pnpm-workspace.yaml')
  const lockFile = path.join(profile, 'pnpm-lock.yaml')

  let workspaceText
  let lockText
  try { workspaceText = fs.readFileSync(workspaceFile, 'utf8') } catch { workspaceText = undefined }
  try { lockText = fs.readFileSync(lockFile, 'utf8') } catch { lockText = undefined }

  const rows = []
  for (const patch of patches) {
    const packageRoot = path.join(profile, 'node_modules', patch.packageName)
    const registered = isRegistered(workspaceText, patch.packageName, patch.version)
    const hash = lockPatchHash(lockText, patch.packageName, patch.version)
    const applied = inspectApplied(packageRoot, patch.packageName)
    // 装着的版本与补丁钉的版本不一致 —— 上游发新版了。这不是"补丁坏了"，
    // 是"补丁该重做了"，得用不同的话告诉人。
    const installed = installedVersion(packageRoot)
    const versionMatches = installed === undefined || installed === patch.version

    rows.push({
      patch,
      registered,
      hash,
      hashMatches: hash === patch.sha256,
      applied,
      installed,
      versionMatches,
      ok: registered && versionMatches && hash === patch.sha256
        && applied.length > 0 && applied.every(row => row.state === 'applied'),
    })
  }

  return { ok: rows.length > 0 && rows.every(row => row.ok), rows, patches }
}

/** 把体检结果折成给日志看的一行行说明（不含 ANSI，宿主日志未必吃颜色）。 */
export function describe(rows) {
  const lines = []
  for (const row of rows) {
    const { patch } = row
    // 版本不符排在最前：此时 pnpm 的报错是 ERR_PNPM_UNUSED_PATCH，
    // 与"补丁没打上"是两回事，先把它讲清楚，免得照着修错方向。
    if (!row.versionMatches) {
      lines.push(
        `${patch.packageName} 已升到 ${row.installed}，本仓补丁钉的是 ${patch.version}` +
          ` —— 补丁不会生效（pnpm 会报 ERR_PNPM_UNUSED_PATCH）。` +
          `跑 node scripts/patch.mjs upgrade 重做补丁`,
      )
      continue
    }
    if (!row.registered) {
      lines.push(`${patch.base}：未登记到 patchedDependencies —— 跑 node scripts/patch.mjs install`)
      continue
    }
    if (row.hash === undefined) {
      lines.push(`${patch.base}：lockfile 里没有 patch_hash —— 跑一次 pnpm install`)
      continue
    }
    if (!row.hashMatches) {
      lines.push(`${patch.base}：lockfile 的 hash 与补丁正本不符（补丁改过但没重打）—— 跑 node scripts/patch.mjs install`)
      continue
    }
    const bad = row.applied.filter(item => item.state !== 'applied')
    if (bad.length > 0) {
      const missing = bad.every(item => item.state === 'missing-file')
      lines.push(
        missing
          ? `${patch.base}：整个包目录不见了（pnpm install 会假装已装好跳过它）—— 跑 node scripts/patch.mjs install，它会用 pnpm add 重新解析`
          : `${patch.base}：${bad.map(item => `${item.file} 未应用`).join('、')} —— 补丁没落到包里，跑 node scripts/patch.mjs install`,
      )
      continue
    }
    lines.push(`${patch.base}：登记、hash、落盘三项齐备（${row.applied.length} 处特征）`)
  }
  return lines
}
