// Smoke test: exercises the engine end-to-end against a throwaway DSH_HOME.
// Run: node scripts/smoke-test.js
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmp = mkdtempSync(join(tmpdir(), 'dsh-guard-test-'))
process.env.DSH_HOME = join(tmp, '.dsh-home')

const {
  snapshotProfile, listSnapshots, restoreSnapshot, resolveSnapshotDir, listProfiles, detectProfile,
  profilePluginRows, parsePatchEntries,
} = await import('../src/engine.js')
const { readPending, writePending, incidentSectionText, resolveIncidentMarker } = await import('../src/incident.js')
const { pendingMarkerPath } = await import('../src/layout.js')

let failures = 0
function check(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

// --- fixture profile（桌面端安装的 profile 就叫 desktop）
const profile = join(tmp, '.dsh-home', 'profiles', 'desktop')
mkdirSync(profile, { recursive: true })
const originalPkg = JSON.stringify({ name: 'test-profile', dependencies: {} }, null, 2)
writeFileSync(join(profile, 'package.json'), originalPkg)
writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n')
writeFileSync(join(profile, 'cordis.patch.yml'), [
  '- id: some-core-row',
  "  name: '@deepseek-ai/dsh-something'",
  '- insert:',
  '    - id: guard',
  "      name: 'dsh-maid-guard'   # 行尾注释也要能剥掉",
  '    - id: maid-vcp',
  "      name: dsh-maid-vcp",
  '',
].join('\n'))

check('listProfiles sees the fixture', listProfiles().includes('desktop'), listProfiles().join(','))
check('detectProfile finds desktop', detectProfile() === 'desktop', detectProfile())

// --- snapshot -> mutate -> restore
const snap = snapshotProfile('desktop', { tag: 'smoke', reason: 'smoke test' })
check('snapshot creates a stamp', Boolean(snap.stamp) && !snap.error, JSON.stringify(snap))
writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'test-profile', broken: true }))
const restored = restoreSnapshot('desktop', resolveSnapshotDir('desktop', { id: snap.stamp }), { skipInstall: true })
check('restore returns files list', Array.isArray(restored.restored) && restored.restored.includes('package.json'))
check('restore brings back the original content', readFileSync(join(profile, 'package.json'), 'utf8') === originalPkg)
const snap2 = snapshotProfile('desktop', { tag: 'smoke' })
check('post-restore snapshot creates a new stamp (pre-rollback differs)', Boolean(snap2.stamp))
const snap3 = snapshotProfile('desktop', { tag: 'smoke' })
check('identical re-snapshot is skipped', snap3.skipped === true)
const forced = snapshotProfile('desktop', { tag: 'smoke', force: true })
check('forced snapshot pins a new stamp', Boolean(forced.stamp))
check('snapshot list is populated', listSnapshots('desktop').length >= 2, `count=${listSnapshots('desktop').length}`)

// --- patch 行解析（内置解析器替掉 js-yaml 的验证：顶层行不误收，insert 行全收）
const entries = parsePatchEntries(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'))
check('patch parser reads top-level rows', entries.length === 1 && entries[0].id === 'some-core-row', JSON.stringify(entries.map((e) => e.id)))
check('patch parser keeps insert rows off the top level', (entries[0].insert ?? []).length === 2, JSON.stringify(entries[0].insert))
const rows = profilePluginRows('desktop')
check('plugin rows keep insert rows only', rows.length === 2 && rows.map((r) => r.id).join(',') === 'guard,maid-vcp', JSON.stringify(rows))
check('plugin rows strip trailing comments', rows[0].name === 'dsh-maid-guard', rows[0].name)

// --- pending marker round trip (with a UTF-8 BOM, as PowerShell 5.1 writes it)
writePending('smoke-test', 'C:/fake/report.md')
const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(pendingMarkerPath())])
writeFileSync(pendingMarkerPath(), bom)
const pending = readPending()
check('marker parses despite BOM', pending !== null && pending.kind === 'smoke-test')
const text = incidentSectionText()
check('section text names the report', text.includes('C:/fake/report.md'))
check('section text is empty without marker', (() => {
  resolveIncidentMarker()
  return incidentSectionText() === ''
})())

// --- cleanup
rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exitCode = failures === 0 ? 0 : 1
