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

> 「专门给这三个插件做维护补丁且不影响他们自己更新的。作者停更了，就收录到里面去。」

（2026-10-15 补：原定三个目标是 better-sidebar / ego-browser / video-understand。ego-browser 原本还背着第二份"右边侧边栏 UI 主题"的补丁——把侧边栏实时面板配色改成深海女仆柔金、复用 maid-atelier 素材、加金框与生成背景图，一路长到 45 KB，改到后来面板外观成了"补丁的下游"，上游一升级就全得重做。老大拍板把**这套 UI 改动全部收掉**，`lib/client.js` 回到 0.8.6 原版；issue #70 那个功能修复不在清理范围内，照旧保留。归档在 `_probe/ego-patch-archive-2026-10-15/`。）

（2026-10-16 补：老大查过 ego-browser 的实际使用度后拍板——「那就不用留了，把 dsh-better-sidebar 和 dsh-ego-browser 这两个卸载了」。两个插件已从 profile 卸掉（依赖 / bundles / cordis.yml 挂载行 / `patchedDependencies` 登记全部清除），本仓随之撤下 ego-browser 补丁；正本归档在 `_probe/ego-patch-archive-2026-10-16/dsh-ego-browser@0.8.6.patch`（3530 字节，md5 `765a8726904d3ced5d7190d5cd1ca869`），哪天再装回来可以照原样重做。**本仓现在只维护 video-understand 一个目标。**）

- **打补丁，不 fork**。fork 出去就分家了，上游每发一版都得手工 rebase，久了就成一具自己的尸体。pnpm patch 让上游照常更新，我们只挂在上面。
- **上游停更才收录接管**。判断依据是作者最近的提交密度，不是主题重不重要。

当前唯一目标的上游活跃度（2026-10-16 实查）：

| 插件 | 仓库 | ★ | 最后 push | 处置 |
|---|---|---|---|---|
| dsh-video-understand | ilps2/dsh-video-understand | 12 | 2026-08-24 | 近两月停更、issue 无人回，打补丁 |

（已退出：dsh-better-sidebar（omdsh-dev/DSH-better-sidebar，活跃，本就不需要补丁）、dsh-ego-browser（Fisfzy/dsh-ego-browser）——两包已于 2026-10-16 从本机卸载。）

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
