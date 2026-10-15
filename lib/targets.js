/**
 * 补丁目标的元信息 —— 中文名、干什么用的、上游仓库、为什么进本仓。
 *
 * 分两层放：`patches/<包名>@<版本>.patch` 是补丁正本，字节级判据在
 * `lib/selfcheck.js` 的 `APPLIED_MARKERS`；这里只放**给人看的那一层**。
 * `patch.mjs list` 与 README 的收录表都从这里取材，免得同一件事在
 * 文档和代码里各写一份、久了互相打架。
 *
 * 两种 status：
 *   patched —— 已收录补丁，`patches/` 下有正本
 *   watch   —— 只登记待命：收了它，但上游还活着，不动手
 * 「收录」与「接管」是两件事——老大要的是把目标登记进来，
 * 上游停更才轮到接管。所以活跃上游也进这张表，只是状态不同。
 *
 * 新增补丁时同步这里：缺条目只是 list 少印两行，不影响体检。
 *
 * @module lib/targets
 */

export const TARGETS = Object.freeze({
  // ── 已接管 ──
  'dsh-video-understand': {
    title: '视频理解',
    summary: 'B站/BV/本地视频丢进去，抽字幕与画面轨迹，出摘要和问答；引擎自带，免配 key。',
    repo: 'ilps2/dsh-video-understand',
    status: 'patched',
    reason: '近两月停更、issue 无人回，且 Windows 下八个问题一条没修',
  },

  // ── 观察中（上游还活着，只登记待命）──
  'dsh-orb': {
    title: '悬浮球',
    summary: '桌面悬浮球：随手呼出聊天窗，能看屏幕、动鼠标键盘，让 AI 直接替你操作电脑。',
    repo: 'mini-yifan/dsh-orb-cordis',
    status: 'watch',
    reason: '上游活跃——2026-10-15 刚发 0.1.7、72 个 open issue 在动，暂不接管',
  },
})

/** 查一个包的元信息。没有就返回空对象，调用方不必判 undefined。 */
export function targetOf(packageName) {
  return TARGETS[packageName] ?? {}
}

/** 按状态取目标，返回 [包名, 元信息] 对。 */
export function targetsWithStatus(status) {
  return Object.entries(TARGETS).filter(([, meta]) => meta.status === status)
}
