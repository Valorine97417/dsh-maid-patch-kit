/**
 * 补丁目标的元信息 —— 中文名、干什么用的、上游仓库、为什么进本仓。
 *
 * 分两层放：`patches/<包名>@<版本>.patch` 是补丁正本，字节级判据在
 * `lib/selfcheck.js` 的 `APPLIED_MARKERS`；这里只放**给人看的那一层**。
 * `patch.mjs list` 与 README 的收录表都从这里取材，免得同一件事在
 * 文档和代码里各写一份、久了互相打架。
 *
 * 新增补丁时同步这里：缺条目只是 list 少印两行，不影响体检。
 *
 * @module lib/targets
 */

export const TARGETS = Object.freeze({
  // ── dsh-video-understand@0.5.2 ──
  'dsh-video-understand': {
    title: '视频理解',
    summary: 'B站/BV/本地视频丢进去，抽字幕与画面轨迹，出摘要和问答；引擎自带，免配 key。',
    repo: 'ilps2/dsh-video-understand',
    reason: '近两月停更、issue 无人回，且 Windows 下八个问题一条没修',
  },
})

/** 查一个包的元信息。没有就返回空对象，调用方不必判 undefined。 */
export function targetOf(packageName) {
  return TARGETS[packageName] ?? {}
}
