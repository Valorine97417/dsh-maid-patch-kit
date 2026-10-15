// dsh-plugin-guard — install safety net for DeepSeek Harness.
//
// In-process half (this plugin):
//  1. systemPrompt section (order -50, before the persona): when
//     $DSH_HOME/guard/pending-incident.json exists it injects an instruction
//     that makes the pending incident the session's first task.
//  2. Tools: incident_resolved, dsh_snapshot, dsh_rollback.
//  3. Pre-tool guard: automatically snapshots every profile before
//     plugin_install / plugin_uninstall / plugin_toggle run (never denies).
//  4. HTTP API (via webServer, when present) backing the 设置 > 备份管理
//     panel: state / snapshot / rollback / keep.
//
// Out-of-process halves (scripts/): standalone CLI (`dsh-guard`), boot guard
// scripts for Windows and POSIX, and PATH shims — see README.
import { snapshotAll, snapshotProfile, listProfiles, listSnapshots, resolveSnapshotDir, restoreSnapshot, readGuardConfig, setKeepSnapshots, DEFAULT_KEEP_SNAPSHOTS, MIN_KEEP_SNAPSHOTS, MAX_KEEP_SNAPSHOTS, detectProfile } from './src/engine.js'
import { incidentSectionText, readPending, resolveIncidentMarker } from './src/incident.js'
import { createGuardTools } from './src/tools.js'

// schemastery 是可选依赖：宿主装的是 @deepseek-ai/schemastery，profile 的
// node_modules 里往往只有裸名 `schemastery`，缺了顶层静态 import 会让整个
// 插件加载失败（桌面端实测 @deepseek-ai/ 目录可能是空的）。这里照
// dsh-maid-vcp 的做法动态可选加载，拿不到就跳过设置命名空间注册。
let zCache
async function loadSchema() {
  if (zCache !== undefined) return zCache
  for (const spec of ['@deepseek-ai/schemastery', 'schemastery']) {
    try {
      const mod = await import(spec)
      zCache = mod.default ?? mod
      return zCache
    } catch { /* try the next specifier */ }
  }
  zCache = null
  return null
}

export const name = 'guard'

const GUARDED_TOOLS = new Set(['plugin_install', 'plugin_uninstall', 'plugin_toggle'])

// Host-side settings scope for this plugin's own namespace (`guard`), set when
// the settings service is available. keepSnapshots stays authoritative in
// guard/config.json (CLI/boot-guard mirror); the scope is the validated write
// path used by the web 设置 surface and the Plugins-tab settings card.
let guardSettingsScope = null

// ── tiny HTTP helpers (plain node:http) ──
const errMsg = (e) => (e && e.message) ? e.message : String(e)

function send(res, data, status = 200) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// ── API handlers ──
async function handleState(_req, res) {
  try {
    const profiles = listProfiles().map((p) => ({
      name: p,
      snapshots: listSnapshots(p).map((s) => ({
        stamp: s.stamp,
        tag: s.tag,
        time: s.time,
        reason: s.reason,
      })),
    }))
    send(res, { ok: true, keepSnapshots: readGuardConfig().keepSnapshots, profiles })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleSnapshot(req, res) {
  try {
    const body = await readBody(req)
    const profile = typeof body.profile === 'string' && body.profile !== '' ? body.profile : undefined
    const results = profile
      ? [snapshotProfile(profile, { tag: 'manual', reason: '手动存档（设置页）' })]
      : snapshotAll('manual', '手动存档（设置页）')
    send(res, { ok: true, results: results.map((r) => r.error ? { profile: r.profile, error: r.error } : r.skipped ? { profile: r.profile, skipped: true } : { profile: r.profile, stamp: r.stamp }) })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleRollback(req, res) {
  try {
    const body = await readBody(req)
    const profile = typeof body.profile === 'string' && body.profile !== '' ? body.profile : detectProfile()
    const stamp = typeof body.stamp === 'string' ? body.stamp : ''
    if (!stamp) return send(res, { ok: false, error: '缺少要加载的快照 stamp' })
    const dir = resolveSnapshotDir(profile, { id: stamp })
    if (!dir) return send(res, { ok: false, error: `profile "${profile}" 找不到快照 ${stamp}` })
    const { pnpm } = restoreSnapshot(profile, dir)
    const target = dir.split(/[\\/]/).at(-1)
    if (pnpm !== null && !pnpm.ok) {
      return send(res, { ok: true, restored: true, stamp: target, warning: `配置文件已还原；pnpm install 失败（exit ${pnpm.status}）：${pnpm.output}` })
    }
    send(res, { ok: true, restored: true, stamp: target, note: '请重启应用使更改生效。' })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleKeep(req, res) {
  try {
    const body = await readBody(req)
    const num = setKeepSnapshots(Number(body.keep))
    // Keep the settings namespace in sync so the 设置 > 插件 card reflects the
    // same value (the namespace schema validates 2-100; config.json is already
    // authoritative and written above).
    if (guardSettingsScope !== null) {
      try { await guardSettingsScope.update({ keepSnapshots: num }) } catch { /* config.json wins; ignore */ }
    }
    send(res, { ok: true, keepSnapshots: num })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

// ── 客户端渲染心跳 / 崩溃回报（黑屏检测）。rc.7 的客户端渲染失败是纯浏览器
// 侧事件，服务端 HTTP 仍返回 200；guard 客户端在根槽位渲染成功时 POST
// /guard/api/booted，在根槽位渲染崩溃时 POST /guard/api/render-error，守护
// 脚本据此区分"服务已起"与"客户端真的能用"。均为进程内内存标志。──
let guardClientBooted = false
let guardRenderError = null // string message; null = 无渲染崩溃

async function handleBooted(req, res) {
  try {
    if (req.method === 'POST') {
      guardClientBooted = true
      return send(res, { ok: true, booted: true })
    }
    send(res, { ok: true, booted: guardClientBooted })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

async function handleRenderError(req, res) {
  try {
    if (req.method === 'POST') {
      const body = await readBody(req)
      guardRenderError = (body && typeof body.message === 'string' && body.message !== '')
        ? body.message : '(client render error)'
      return send(res, { ok: true, renderError: true })
    }
    // GET carries BOTH signals so the boot-guard can confirm health or crash
    // from this single endpoint.
    send(res, { ok: true, renderError: guardRenderError !== null, message: guardRenderError ?? '', booted: guardClientBooted })
  } catch (e) { send(res, { ok: false, error: errMsg(e) }) }
}

export function apply(ctx) {
  // 1. 事故提醒：注入 systemPrompt 的一个 section。
  const sp = ctx.get('systemPrompt')
  if (sp !== undefined) {
    sp.section({
      name: 'guard:incident-alert',
      order: -50,
      text: () => incidentSectionText(),
    })
  }

  // 2. 装插件前的自动存档 + 三个 guard 工具。tools.guard 是纯副作用钩子：
  // guard 从不拦截，快照出错也吞掉——安全网不能反过来把安装本身堵死。
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    tools.guard((execution) => {
      if (GUARDED_TOOLS.has(execution.name)) {
        try {
          snapshotAll('auto-before-install', `pre-tool guard for ${execution.name}`)
        } catch {
          // never block the install because the guard failed
        }
      }
      return undefined
    })

    for (const tool of createGuardTools()) {
      tools.register(tool)
    }
  }

  // 3. 设置 > 备份管理 的 HTTP API。挂在 webServer 上（桌面端与网页端都由
  // 宿主起一个）。用 ctx.inject 而不是 ctx.get，是为了「webServer 晚于本行
  // 挂载」时也还能注册；它是非阻塞的——没有 webServer 的 profile 就永远拿
  // 不到这些路由，也不会报错。
  ctx.inject(['webServer'], (wctx) => {
    const routes = [
      { kind: 'exact', path: '/guard/api/state', handler: handleState },
      { kind: 'exact', path: '/guard/api/snapshot', handler: handleSnapshot },
      { kind: 'exact', path: '/guard/api/rollback', handler: handleRollback },
      { kind: 'exact', path: '/guard/api/keep', handler: handleKeep },
      { kind: 'exact', path: '/guard/api/booted', handler: handleBooted },
      { kind: 'exact', path: '/guard/api/render-error', handler: handleRenderError },
    ]
    for (const route of routes) {
      wctx.effect(() => wctx.webServer.register(route), `guard: ${route.path} route`)
    }
  })

  // 4. 插件自有设置表面（rc.7 有命名空间注册；rc.2 只有 configure/describe/
  // update，没有 `register`）。所以整段做成软探测：settings 服务上没有
  // `register` 就直接跳过，保留数量仍旧以 guard/config.json 为准（设置 >
  // 备份管理 页面的输入框走 /guard/api/keep 写它）。config.json 始终是
  // 权威存储，CLI 与守护脚本都读它。llm.registerConfigurableProviders 把命名
  // 空间暴露给 web 配置边界——缺这条目录项，浏览器侧的 settingsScope 绑定
  // 会报「不可用」。全部 best-effort：settings/llm 出错绝不能拖垮 guard。
  ctx.inject(['settings'], (sctx) => {
    sctx.effect(() => () => { guardSettingsScope = null }, 'guard: settings scope teardown')
    void (async () => {
      try {
        const settings = sctx.settings
        if (settings === undefined || typeof settings.register !== 'function') return
        const z = await loadSchema()
        if (z === null) return
        const cfg = readGuardConfig()
        const scope = settings.register('guard', z.object({
          keepSnapshots: z.number().min(MIN_KEEP_SNAPSHOTS).max(MAX_KEEP_SNAPSHOTS).default(cfg.keepSnapshots),
        }), { base: { keepSnapshots: cfg.keepSnapshots } })
        guardSettingsScope = scope
        // seed the settings document from config.json so the card matches the CLI
        void scope.update({ keepSnapshots: cfg.keepSnapshots }).catch(() => {})
        // mirror every settings change back to config.json (CLI/boot-guard truth)
        scope.watch(() => {
          try {
            const v = scope.get()
            if (v && Number.isFinite(v.keepSnapshots)) setKeepSnapshots(v.keepSnapshots)
          } catch { /* best effort */ }
        })
        const llm = ctx.get('llm')
        if (llm !== undefined) {
          try {
            llm.registerConfigurableProviders([{ provider: 'guard', displayName: '备份管理（dsh-maid-guard）' }])
          } catch { /* best effort */ }
        }
      } catch {
        // settings unavailable — the guard runs without the namespace
      }
    })()
  })
}

export { readPending, resolveIncidentMarker }
