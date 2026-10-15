# dsh-maid-patch-kit

> DSH 小困插件 · 第三方插件维护：给社区插件打**不阻碍上游更新**的维护补丁，每次启动体检补丁是否还活着；上游停更的收录接管。

## 这包解决什么问题

有些社区插件在 Windows 上跑不起来，或者缺一小块你正好需要的东西。小困给它们修好了——**手改在 `node_modules/` 里**。

然后 2026-10-14 那天，装一个别的插件触发了 pnpm 重铺：

```
Packages: +1 -29
```

再去看，`dsh-video-understand` 的七处修复**全没了**，`.venv` 也没了，整个包回到纯原版。没有报错，没有提示，直到小困再调 `video_understand`，才发现工具根本不在。

**改 `node_modules` 等于没改。**

这包把那些修改转正成 pnpm patch：补丁正本存在 `patches/`，登记写进 profile 的 `pnpm-workspace.yaml`，hash 记进 lockfile。此后**任何一次 install / 重铺都会自动重打**——上游照常升级，补丁跟着走。

代价是：上游发新版时补丁的版本键会悬空（pnpm 报 `ERR_PNPM_UNUSED_PATCH` 并中止 install），得跑一次 `upgrade` 把补丁重做到新版本上。这是明账，比静默失效强。

## 收录原则（老大定的）

> 「专门给这些插件做维护补丁且不影响他们自己更新的。作者停更了，就收录到里面去。」

- **打补丁，不 fork**。fork 出去就分家了，上游每发一版都得手工 rebase，久了就成一具自己的尸体。pnpm patch 让上游照常更新，我们只挂在上面。
- **收录 ≠ 接管**。目标一律登记进表（`lib/targets.js`），但 `patched` 与 `watch` 两种状态分得清：上游停更才轮到接管打补丁，还活着就只登记待命，等它哪天不动了再说。判断依据是作者最近的提交密度，不是主题重不重要。

当前目标的上游活跃度（2026-10-16 实查）：

| 插件（包名） | 中文名 | 能用来干嘛 | 仓库 | ★ | 最后 push | 状态 | 处置 |
|---|---|---|---|---|---|---|---|
| dsh-video-understand | 视频理解 | B站/BV/本地视频丢进去，抽字幕与画面轨迹，出摘要和问答；引擎自带，免配 key。 | ilps2/dsh-video-understand | 12 | 2026-08-24 | patched | 近两月停更、issue 无人回，已打补丁 |
| dsh-orb | 悬浮球 | 桌面悬浮球：随手呼出聊天窗，能看屏幕、动鼠标键盘，让 AI 直接替你操作电脑。 | mini-yifan/dsh-orb-cordis | 239 | 2026-10-15 | watch | 上游正活跃（0.1.7 刚发、72 issue 在动），只登记待命 |

这张表不是手抄的：中文名、用途、仓库与状态存在 `lib/targets.js`，`node scripts/patch.mjs list` 打印的是同一份。**新增目标时同步那个文件**，否则 `list` 少印两行——不报错，只是不好看。

## 用法

```bash
node scripts/patch.mjs list                 # 看本仓带哪些补丁、目标版本
node scripts/patch.mjs install              # 登记 + pnpm install + 核对（--dry-run 可预演）
node scripts/patch.mjs verify               # 只核对：登记、hash、落盘字节
node scripts/patch.mjs remove               # 撤销登记与补丁文件，再 pnpm install
node scripts/patch.mjs upgrade              # 上游升版后重做补丁（--to <版本> 可指定）
node scripts/venv.mjs                       # 补 dsh-video-understand 的 Python 运行时
```

改完补丁要**重启 DSH** 才生效（宿主在启动时加载插件）。

## 补丁清单

### `dsh-video-understand@0.5.2.patch`（21 KB，7 个文件）

上游仓库最后 push 是 2026-08-24，Windows 下 issue #1 列的八条问题**一条没修**，issue 也无人回。补丁分三部分：

**A. 让它能在 DSH 里注册（不改则工具根本不存在）**
- `dsh/index.js`：`upgrade_layer: { type: ['string','null'] }` → `{ type: 'string' }`。DSH 0.2.0-rc.2 拒绝 type 数组，报 `must be a single type string (type arrays are not supported)`，工具静默不注册。
- `dsh/index.js`：输出兜底，`return { ...parsed, video }`，把字符串 `video` 规整成对象。原版 outputSchema 声明 object 却返回 string，DSH 判 `"value.video" must be an object` 丢弃整个结果。

**B. Windows 编码（不改则随机崩）**
- `engine/avis.py`：包一层 `subprocess.run`，text 模式默认补 `encoding='utf-8', errors='replace'`。上游 18 处 `text=True` 无 encoding，中文 Windows 下按 cp936 解 UTF-8 输出直接抛 `UnicodeDecodeError`。
- `dsh/index.js`：spawn 引擎时注入 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`（上游作者本机靠环境变量绕过，所以没修代码）。
- `engine/understand_video.py`：`_detect_python()` 优先返回 `sys.executable`。上游候选只有 macOS 框架路径与 `python3`——Windows 上没有 `python3` 这个名字。
- `engine/requirements.txt` / `requirements-layer.txt`：头加 UTF-8 BOM。原文件无 BOM + 中文注释，pip 按 cp936 解码抛 `UnicodeDecodeError: 'gbk' codec can't decode byte 0xab`。
- `engine/requirements.txt`：补 `pandas>=2.0`（`avis.py` 依赖它但上游漏列）。

**C. 接 DSH 本地网关（不改则要另配一把外部 key）**
- 三个文件各加 `_gateway_config()` 与 `_profile_default_model()`：LLM 出口改指 `http://127.0.0.1:8326/v1/chat/completions`，key 读 `$DSH_HOME/openai-gateway/api-key`，模型从 profile 的 `cordis.yml` 读 `agent-default-model`（回落 `workbuddy/deepseek-v4.1-flash`）。插在 credentials 回落之前，env 显式覆盖仍最优先；`VIDEO_UNDERSTAND_NO_GATEWAY=1` 可关。
- `engine/visual_level.py`：`vlm_frames()` 的 messages 首条补 system。网关渠道（workbuddy）硬性要求首条是 system，否则 400。
- `engine/visual_level.py`：`max_tokens` 2048 → 4096。网关模型带 reasoning，预算不够会返回 `content: null` + `finish_reason: length`。

另附：`engine/understand_video.py` 的下载格式串从 `worst[ext=mp4]/worst` 改为 `bv*[height<=360]+ba/b[height<=360]/worst`（B站不提供带音轨的 mp4，原串报 `Requested format is not available`），裸 BV 号补成完整 URL 走 yt-dlp（不再依赖不存在的 `~/.agents/skills/bilibili-downloader/scripts/bili_download.py`）。

## 启动自检

`index.js` 在 DSH 启动时跑一次 `lib/selfcheck.js`，问三件事（缺一不可，因为它们是三个独立的失效点）：

1. **登记还在吗** —— `pnpm-workspace.yaml` 的 `patchedDependencies` 有没有这一条
2. **hash 对得上吗** —— lockfile 的 `patch_hash` 是不是 `.patch` 正本的 sha256
3. **字节落盘了吗** —— 上游包里那些文件**逐文件**含补丁特征吗

任何一项掉了就 `warn` 出来，附上修它的那一条命令。**它不修、不拦、不抛**——一个体检器没有资格让应用起不来。

第 3 问必须逐文件问：这里的补丁动辄跨六七个文件，只抽查一个的话，恰好漏掉没打上的那一个就白体检了。

## 两个坑

**pnpm 的盲区**：如果整个包目录被外部删掉（`rm -rf node_modules/<pkg>`），`pnpm install` 的账本仍认为"已装好"，回一句 `Already up to date` 直接跳过——`--force`、删 `.modules.yaml` 都不管用。补丁文件、登记、lockfile 全对，包里却一个字都没有。唯一出路是 `pnpm add <name>@<version>` 让它重新解析。`install` 子命令检测到 `missing-file` 时会自动走这条回退。

**`.venv` 不在补丁管辖范围**：`dsh-video-understand` 的 Python 运行时住在包目录内部（`node_modules/dsh-video-understand/.venv`），pnpm 重铺时跟着包一起被删。补丁能保住，`.venv` 保不住——它不是补丁能表达的东西。所以另配了 `scripts/venv.mjs` 幂等重建（用 DSH 自带的 Python 3.12，走清华镜像）。

## 边界

- 本包**不改**上游任何仓库，只维护 `patches/` 下的补丁正本与登记。
- 上游发新版后补丁不会自动适配，跑 `upgrade`（用 `git apply` 试重放，贴不上会明确报出是哪个文件哪一段）。
- 补丁内容改了，**必须同步** `lib/selfcheck.js` 的 `APPLIED_MARKERS`，否则体检会说谎。
- 本包只面向本机 desktop profile，不试图做成通用工具。

## License

MIT
