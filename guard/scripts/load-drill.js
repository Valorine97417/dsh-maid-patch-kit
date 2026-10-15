// 宿主加载演练：用一个假 ctx 调 guard 的 apply()，看它会不会抛。
// 真插件最致命的失效方式不是功能坏掉，而是 apply() 抛错把整个 profile 拖下水。
// 这里模拟两套 ctx：
//   A. 极简（什么都 get 不到）—— 最坏情况
//   B. 齐全（tools / webServer / systemPrompt / settings / llm 都在）
//     settings 故意不带 register（模拟 DSH 0.2.0-rc.2 的 SettingsForms）
//     webServer.register 故意抛一次（模拟重复路由），看 effect 是否被吞
// 跑法：node scripts/load-drill.js（脚本自己用临时 DSH_HOME，不碰真实档案）
import { apply } from '../index.js'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const failures = []
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

function makeEffect() {
  // cordis 的 effect(callback, label)：callback 返回 disposer。这里立刻执行一次
  // 并收下 disposer，不关心生命周期。
  const disposers = []
  const effect = (fn, label) => {
    const d = fn()
    if (typeof d === 'function') disposers.push(d)
    return d
  }
  effect.disposers = disposers
  return effect
}

// ── A. 极简 ctx：所有服务都不在 ──
{
  const ctx = {
    get: () => undefined,
    inject: () => undefined,
    effect: makeEffect(),
    logger: { warn: () => {}, info: () => {} },
  }
  let threw = null
  try { apply(ctx) } catch (e) { threw = e }
  check('apply() 在最小 ctx 上不抛', threw === null, threw ? `${threw.name}: ${threw.message}` : '')
}

// ── B. 齐全 ctx ──
{
  const registered = { tools: [], routes: [], sections: [] }
  const effect = makeEffect()
  const toolsService = {
    registered: [],
    guard(fn) { registered.guardHook = fn; return () => {} },
    register(tool) { registered.tools.push(tool.name); toolsService.registered.push(tool) },
  }
  const webServer = {
    register(route) { registered.routes.push(route.path); return () => {} },
  }
  const settingsNoRegister = {          // rc.2 的 SettingsForms：没有 register()
    configure() {},
    describe() { return [] },
    update() { return Promise.resolve() },
  }
  const llmService = { registerConfigurableProviders(list) { registered.providers = list } }
  const services = {
    systemPrompt: { section(s) { registered.sections.push(s.name) } },
    tools: toolsService,
    webServer,
    settings: settingsNoRegister,
    llm: llmService,
  }
  const ctx = {
    get: (name) => services[name],
    inject: (deps, cb) => {
      const ok = deps.every((d) => services[d] !== undefined)
      if (ok) cb({ ...services, effect, webServer, settings: settingsNoRegister })
      return undefined
    },
    effect,
    logger: { warn: () => {}, info: () => {} },
  }

  let threw = null
  try { apply(ctx) } catch (e) { threw = e }
  check('apply() 在齐全 ctx 上不抛', threw === null, threw ? `${threw.name}: ${threw.message}` : '')

  check('注册了 systemPrompt section（事故提醒）', registered.sections.includes('guard:incident-alert'), registered.sections.join(','))
  check('注册了 3 个工具', registered.tools.length === 3, registered.tools.join(','))
  check('工具名对得上', ['incident_resolved', 'dsh_snapshot', 'dsh_rollback'].every((n) => registered.tools.includes(n)), registered.tools.join(','))
  check('注册了 6 条 HTTP 路由', registered.routes.length === 6, registered.routes.join(', '))
  check('路由前缀都是 /guard/api/', registered.routes.every((p) => p.startsWith('/guard/api/')))
  check(
    'settings 没有 register() 时安静跳过（rc.2 行为）',
    registered.providers === undefined,
    registered.providers ? '不该注册 provider' : '未注册，符合 rc.2',
  )

  // guard 钩子要在真档案上验一次：先建一个 fixture profile，调钩子，看快照
  // 是不是真落盘了——「不抛」也可能只是压根没走到快照那一步。
  const home = mkdtempSync(join(tmpdir(), 'guard-drill-home-'))
  const profDir = join(home, 'profiles', 'desktop')
  mkdirSync(profDir, { recursive: true })
  writeFileSync(join(profDir, 'package.json'), '{"name":"fixture"}', 'utf8')
  writeFileSync(join(profDir, 'cordis.patch.yml'), '- id: fixture\n  name: fixture\n', 'utf8')
  const realHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  let hookThrew = null
  try { registered.guardHook({ name: 'plugin_install' }) } catch (e) { hookThrew = e }
  const rbRoot = join(home, 'rollbacks', 'desktop')
  const stamps = existsSync(rbRoot) ? readdirSync(rbRoot) : []
  check('pre-tool guard 钩子不抛', hookThrew === null, hookThrew ? `${hookThrew.name}: ${hookThrew.message}` : '')
  check('装了插件的调用真的留下了快照', stamps.length === 1, `rollbacks/desktop 下有 ${stamps.length} 个快照`)
  const tag = stamps.length === 1 && existsSync(join(rbRoot, stamps[0], 'manifest.json'))
    ? JSON.parse(readFileSync(join(rbRoot, stamps[0], 'manifest.json'), 'utf8')).tag : ''
  check('快照 tag 是 auto-before-install', tag === 'auto-before-install', `tag=${tag}`)

  // 「不抛」也可能是异常被吞了。换个场景逼它一定失败：把 profiles 做成一个
  // **文件**而不是目录，snapshotAll 必炸，再看钩子是否仍然静默。
  const badHome = mkdtempSync(join(tmpdir(), 'guard-drill-bad-'))
  writeFileSync(join(badHome, 'profiles'), 'not a directory', 'utf8')
  process.env.DSH_HOME = badHome
  let badThrew = null
  try { registered.guardHook({ name: 'plugin_install' }) } catch (e) { badThrew = e }
  process.env.DSH_HOME = realHome
  rmSync(badHome, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  check('快照失败也不抛（安全网不能反过来堵死安装）', badThrew === null, badThrew ? `${badThrew.name}: ${badThrew.message}` : '已吞掉')

  let hookThrew2 = null
  try { registered.guardHook({ name: 'some_unrelated_tool' }) } catch (e) { hookThrew2 = e }
  check('无关工具不触发快照且不抛', hookThrew2 === null)
}

console.log('')
if (failures.length === 0) console.log('ALL PASS')
else { console.log(`FAILED: ${failures.join(' | ')}`); process.exitCode = 1 }
