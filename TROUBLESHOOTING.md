# dsh-maid-patch-kit · 问题与解决记录

> 用途：本仓（第三方插件维护：给社区插件打不阻碍上游更新的维护补丁 + 上游停更的整包接管）在**新设备上安装、迁移、重装**时的参考。
> 每条按「症状 → 原因 → 解法 → 验证方式」写，症状照抄实测报错。只在有据可查时下结论，不确定的标「（待核）」。
> 素材来源：本仓源码与注释（`scripts/patch.mjs`、`lib/selfcheck.js`、`README.md`、`guard/`）、记忆库、2026-10-14 ~ 10-18 的会话原文与终端输出。
>
> 最后更新 2026-10-18

本机基线（写文档时实查，供对照）：

| 项 | 值 |
|---|---|
| profile | `C:\Users\Kayle\.dsh\profiles\desktop` |
| 补丁正本 | `patches/dsh-video-understand@0.5.2.patch`（21313 字节，sha256 `e09ed330c4e244254f1f3d39e27c14c6cd21b03ab110f7dc7a0bfc674a1d8aba`） |
| 目标包 | `dsh-video-understand@0.5.2`（profile/node_modules 内） |
| 接管包 | `dsh-maid-guard`（`link:` 到本仓 `guard/`，0.3.2-fork.1） |
| 体检结果 | `node scripts/patch.mjs verify` → 「全部核对通过。」

---

## 一、安装与部署

### 1.1 补丁在装了别的插件之后整批消失

**症状**：装一个不相关的插件后，pnpm 输出 `Packages: +1 -29`；随后 `dsh-video-understand` 的七处 Windows 修复全没了、`.venv` 也没了，`video_understand` 调用直接报**工具不存在**。全程没有任何报错或提示。

**原因**：这些修复当初是**手改进 `node_modules/`** 的。pnpm 的 hoisted linker 在每次 `plugin add` 触发安装时会重建 node_modules，手改内容跟着包一起被抹平。手改 = 没改。

**解法**：走 pnpm patch 转正——补丁正本放 `patches/`，登记写进 profile 的 `pnpm-workspace.yaml`，hash 落进 lockfile，之后任何一次 install / 重铺都会自动重打。

**验证方式**：`node scripts/patch.mjs list` 能看到补丁条目与「版本吻合」；`node scripts/patch.mjs verify` 打印 `✓ 登记` / `✓ lockfile hash 与补丁正本一致` / 逐文件 `✓ 落盘`。

### 1.2 把本仓接进新设备的 desktop profile

**症状**：全新设备上 `node scripts/patch.mjs install` 报 `找不到 C:\Users\<用户>\.dsh\profiles\desktop\pnpm-workspace.yaml，profile 路径对吗？（用 --profile 指定）`。

**原因**：patch-kit 只认 profile 目录里的 `pnpm-workspace.yaml` / `pnpm-lock.yaml`。profile 路径解析顺序为：`--profile <dir>` → 环境变量 `DSH_PROFILE_DIR`（且目录必须存在）→ 兜底 `~/.dsh/profiles/desktop`。新设备的 profile 名或落点不同就会命中兜底值。

**解法**（顺序别换）：

1. `git clone https://github.com/Valorine97417/dsh-maid-patch-kit.git`（本机直连 GitHub 报过 `Recv failure: Connection was reset`，实测走代理可用：`git -c https.proxy=http://127.0.0.1:7890 clone …`；clone 走代理这一条（待核），push 是实测过的）。
2. profile 的 `package.json` 的 `dependencies` 加两条 link 依赖：
   - `"dsh-maid-patch-kit": "link:<本仓绝对路径>"`
   - `"dsh-maid-guard": "link:<本仓绝对路径>/guard"`（接管包，正本在 `guard/`）
3. 同文件 `dsh.profile.bundles` 数组里同样加上 `dsh-maid-patch-kit`、`dsh-maid-guard`，然后 `pnpm install`。
4. `node scripts/patch.mjs install`（登记 + pnpm install + 核对，会自动带门禁覆盖重试一次）。
5. `node scripts/venv.mjs`（补 `dsh-video-understand` 的 Python 运行时，见 1.4）。
6. **重启 DSH**——宿主只在启动时加载插件并跑体检。

**验证方式**：profile 的 `package.json` 里两条 link 在、bundles 里有名；`node scripts/patch.mjs list` 里「已接管」段显示 `dsh-maid-guard（已接入 0.3.2-fork.1）`、`dsh-orb（已装 0.1.7）`；重启后 `verify` 仍全部通过。

### 1.3 pnpm 安装被供应链门禁拦下（本机已遇到两次）

**症状**：

```text
✗ Lockfile failed supply-chain policy check (51 entries in 3.7s)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 1 lockfile entries failed verification:
billion-context@0.1.197 was published at 2026-10-14T08:34:39.130Z, within the minimumReleaseAge cutoff (2026-10-13T12:36:36.937Z)
```

2026-10-14 装 `dsh-plugin-guard`（后由本仓接管为 `dsh-maid-guard`）时就是被这一条拦在半路，本机当时从没装上过它。

**原因**：profile 的 lockfile 里**别的**包触犯 pnpm 的 `minimumReleaseAge`（24 小时冷却）。补丁本身的登记与补丁文件其实已经写好，只差 install 这一步——即门禁挡住的是整次安装，不是补丁内容。

**解法**：命令行传 `--config.minimumReleaseAge=0`：

```bash
node "D:/DeepSeek Harness/resources/runtime/pnpm/bin/pnpm.cjs" install --config.minimumReleaseAge=0   # cwd: profile
```

- **环境变量方式实测无效**（`npm_config_minimum_release_age` 不生效），只能从 argv 传——`scripts/patch.mjs` 里也是这么写的（`POLICY_OVERRIDE_ARGS`）。
- `scripts/patch.mjs install` 默认仍受门禁保护，只在裸跑失败时**自动带覆盖重试一次**（仅本次调用，不改配置文件）；手工 install 需自己加参数。
- 另有正道一条：把该包写进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`（本机已列 `dsh-whale-widget@0.4.2`、`billion-context@0.1.195 || 0.1.196 || 0.1.197`、`dsh-ops@0.3.0`、`dsh-orb`、`@michengai/dsh-skills-manager@1.1.23`）。

**验证方式**：重跑 install 退出码 0；`node scripts/patch.mjs verify` 全绿。注意一个实测现象：**第一次失败时 junction 与 lock 条目可能已经写入**，所以别只看「包目录在不在」，要看 verify。

### 1.4 `.venv` 不在补丁管辖范围，重铺后必须重建

**症状**：重铺后 `video_understand` 首次调用长时间等待后失败，或提示找到的 Python 不对；直接看是 `node_modules/dsh-video-understand/.venv` 整个目录不存在。手动执行 `venv.mjs --verify` 时打印「`.venv` 不存在（pnpm 重铺会连它一起删）」。

**原因**：`.venv` 住在包目录**内部**，pnpm 重铺会连包带它一起删。补丁能用 pnpm patch 保住，`.venv` 不是补丁能表达的东西。上游引擎虽有懒安装（`dsh/env.mjs`：uv → `python3 -m venv`，走清华镜像），但那一步依赖 `python3` 这个名字，**Windows 上没有**。

**解法**：`node scripts/venv.mjs`（幂等：缺就建、有就核对；`--force` 删了重建，`--verify` 只看状态）。它用 DSH 自带的 Python 3.12 预建，pip 走 `https://pypi.tuna.tsinghua.edu.cn/simple`。找不到自带 Python 时按它打印的提示传 `--python <路径>`（3.9–3.13 均可）。自带 Python 的两个候选落点：

```text
C:/Users/Kayle/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/python.exe
D:/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/python/python.exe
```

**验证方式**：脚本末行打印「Python 运行时齐备。」；机械核对是 `.venv/Scripts/python.exe` 存在，且核心依赖 `faster_whisper`、`cv2`、`yt_dlp` 三个 import 全通过（脚本用一次 `python -c` 全试）。**目录在但包不全（上次装到一半）也是真实会发生的状态**，所以别只查目录。

### 1.5 接管包（guard）在桌面端装上也是死的

**症状**：上游原版 `dsh-plugin-guard` 装上后，设置页那块「备份管理」永远不出现，且**什么都不报**；回滚接口翻的是一个不存在的 profile；健康检查一直报「服务未就绪」。

**原因**：上游最后提交 `c95036f`（v0.3.2）停在 2026-08-18，且原版照**网页版**写：默认 profile 写死 `'web'`（`src/index.js:85`、`src/tools.js:183`、`src/incident.js:210/218`、`scripts/guard-cli.js:172`）；健康检查端口写死 `3080`（桌面端真实端口是运行期由 `dsh-desktop-host` 传的 **19387**）；`lib/client.js` 的 `exports.inject = ['slots', 'settingsScope']` 里 `settingsScope` 与 `settings.plugin.item` 槽位在 DSH 0.2.0-rc.2 已被移除；`package.json` 的 `dsh.client.inject` 还声明了 rc.2 不存在的 `@deepseek-ai/dsh-client-runtime`——所以宿主半都进不去。

**解法**：整包接管为本仓 `guard/`（改动面横跨宿主半、客户端半、CLI 与守护脚本，pnpm patch 装不下；且没有新版可跟，补丁那条路对停更包本就无效）。关键改动：新增 `src/profile.js` 收拢环境知识（`detectProfile()` / `portCandidates()` → `[DSH_GUARD_PORT?, 配置值, 19387, 3080]`）；去掉唯一运行时依赖 `js-yaml`（桌面端 `node_modules/@deepseek-ai` 是**空目录**，裸名只有 `schemastery`，静态 import 会让整个插件加载失败）；`index.js` 的 schemastery 改动态可选加载、`settings.register` 改软探测；健康判据放宽到 2xx–4xx（**401 也算活**，桌面端根路径要鉴权 token）。接入方式同 1.2 的 `link:` + bundles。

**验证方式**：`node guard/scripts/smoke-test.js`（16 项自测）与 `node guard/scripts/load-drill.js`（宿主加载演练，13 项），末行都应是 `ALL PASS`；`node guard/scripts/guard-cli.js status` 看健康 + 待处理事故。

> `guard/` 是**独立包**（`dsh-maid-guard`，单独一套 `package.json` 与 `0.3.2-fork.N` 版本号），它自己的坑另有子册：[`guard/TROUBLESHOOTING.md`](guard/TROUBLESHOOTING.md)（快照/回滚、事故检测与隔离、守护启动脚本）。本册只管 patch-kit 主体。

---

## 二、补丁失效与体检告警（上游更新后怎么办）

### 2.1 上游发新版，补丁版本键悬空，pnpm 中止整个 install

**症状**：

```text
[ERR_PNPM_UNUSED_PATCH] ...
```

install 直接停住；`node scripts/patch.mjs verify` 打印 `✗ 版本：装着 0.5.3，补丁钉的是 0.5.2`。启动时体检也会 warn：`dsh-video-understand 已升到 0.5.3，本仓补丁钉的是 0.5.2 —— 补丁不会生效（pnpm 会报 ERR_PNPM_UNUSED_PATCH）。跑 node scripts/patch.mjs upgrade 重做补丁`。

**原因**：`patchedDependencies` 的键是**精确版本**（`<包>@<版本>`）。上游一升版，旧键失去对应包，pnpm **报错中止**而不是静默降级（这点是好事，但升级路径被堵死）。

**解法**：`node scripts/patch.mjs upgrade`（`--to <版本>` 可指定目标，`--dry-run` 预演）。流程：`pnpm patch <包>@<新版本>` 出临时目录 → `git apply -p1 --whitespace=nowarn` 重放旧补丁 → `node --check` 语法检查（不过就绝不 commit）→ `pnpm patch-commit` → 旧补丁改名入库 → 清掉 profile 里旧版本名的补丁文件（留着会再次触发 `ERR_PNPM_UNUSED_PATCH`）→ verify。

**验证方式**：`patches/` 下出现 `dsh-video-understand@<新版本>.patch`；`pnpm-workspace.yaml` 的登记键跟着换版本；`verify` 全绿。**注意**：补丁内容若改动过，必须同步 `lib/selfcheck.js` 的 `APPLIED_MARKERS`，否则体检会说谎（`patch.mjs` 会在 upgrade 结束时提醒这一句）。

### 2.2 体检告警该怎么读（三问缺一不可）

**症状**：启动日志里出现 `WARN [patch-kit] <某一行>`，或 `verify` 出现 `✗`。正常时是 `INFO [patch-kit] 补丁齐备：dsh-video-understand@0.5.2（profile: C:\Users\Kayle\.dsh\profiles\desktop）`。

**原因**：补丁的失效点有三个、彼此独立——① 登记（`pnpm-workspace.yaml` 的 `patchedDependencies`）② hash（lockfile 的 `patch_hash` 是否等于 `.patch` 正本的 sha256）③ 落盘（上游包里**逐文件**是否真的含补丁特征串）。

**解法**（按告警原文对症，别串台）：

| 告警原文 | 含义 | 处置 |
|---|---|---|
| `未登记到 patchedDependencies` | 登记没了 | `node scripts/patch.mjs install` |
| `lockfile 里没有 patch_hash` | 装了但没重打过的记录 | 跑一次 `pnpm install` |
| `lockfile 的 hash 与补丁正本不符（补丁改过但没重打）` | 正本被改过 | `node scripts/patch.mjs install` |
| `整个包目录不见了（pnpm install 会假装已装好跳过它）` | 见 2.3 | `node scripts/patch.mjs install`（内部走 `pnpm add`） |
| `<文件> 未应用` | 补丁没落到包里 | `node scripts/patch.mjs install` |
| `已升到 X，本仓补丁钉的是 Y` | 上游升版 | 见 2.1 的 `upgrade` |

启动时的收尾提示固定是：`[patch-kit] 补丁掉了就等于没修。修：node scripts/patch.mjs install，然后重启 DSH`。体检器本身**不修、不拦、不抛**——任何读不到的路径都折成一句人话，不能让它把应用拖下水。

**验证方式**：`node scripts/patch.mjs verify` 每一项都是 `✓`，末行「全部核对通过。」。逐文件判据在 `lib/selfcheck.js` 的 `APPLIED_MARKERS`（当前 11 条，覆盖 7 个文件）。

### 2.3 pnpm 的盲区：包目录被外部删掉，install 却说「Already up to date」

**症状**：`pnpm install` 输出 `Already up to date` 随即结束；但 `verify` 报整包 `missing-file`（`✗ 落盘：dsh/index.js 文件缺失`）。补丁文件、登记、lockfile 全对，包里却一个字都没有。

**原因**：整个包目录被外部删过（`rm -rf node_modules/<pkg>`）时，pnpm 的账本仍认为「已装好」——**连 `--force`、删掉 `node_modules/.modules.yaml` 都不管用**。

**解法**：让 pnpm 重新解析这个包：`pnpm add <包名>@<版本>`（同版本重装不改 `dependencies`，只补回目录）。`patch.mjs install` 检测到 `missing-file` 时会自动走这条回退，不必手工。

**验证方式**：`ls node_modules/<包名>/package.json` 存在；`verify` 三问全绿。

### 2.4 补丁没打上时，插件表现为「上游原版的那几个错」

**症状**（任选其一出现，都可能是补丁失效）：

- `[video-understand] tool registration skipped: JsonSchemaError: unsupported JSON schema: schema.properties.routing.properties.upgrade_layer.type must be a single type string (type arrays are not supported)`——工具**静默不注册**，工具列表里没有 `video_understand`。
- B 站下载：`ERROR: [BiliBili] BV1kYYF6xE6r: Requested format is not available.`
- pip 装依赖：`UnicodeDecodeError: 'gbk' codec can't decode byte 0xab`（无 BOM + 中文注释的 `requirements*.txt`）。
- 引擎侧随机 `UnicodeDecodeError`（18 处 `text=True` 无 encoding）。
- 结果被丢弃：`"value.video" must be an object`。

**原因**：这些正是补丁修掉的八条 Windows 问题；补丁失效时包回到纯原版，症状原样重现。

**解法**：先 `node scripts/patch.mjs verify` 定性（是补丁掉了，还是上游升版），再按 2.1/2.2 处置；`.venv` 相关的失败另见 1.4。

**验证方式**：`verify` 全绿后重启 DSH，`video_understand` 回到工具列表；本地视频与裸 BV 号各跑一次。

### 2.5 重复皮肤包回潮：装回 `maid-atelier` 就顶掉 scenery 的视频层

**症状**：装上一个不相关的插件、或从旧笔记里照抄依赖之后，出现以下之一：deep-sea 女仆工坊的蕾丝/侧栏/素材重复叠两层（同一张工坊画盖两层）；或者反过来，视频层的路由整批不见了——页面上「就是少了点什么」，日志里只有一行 `warning`，**没有报错**。

**原因**：`@smalltailqwq/dsh-client-ui-skin-maid-atelier` 与 `dsh-maid-scenery` 内置的主题层**是同一份东西**——`client.js` 字节级相同、32 个素材一个不差、`skin.json` 的 `id` 同为 `maid-atelier`。两套同时在场就重复注入、互相打架；而且这个包的路由会赢过 scenery 内置视频层，把它的路由整批挤掉，而 scenery 把路由注册包在 `try/catch` 里，失败只落一行 warning。2026-10-17 实打实撞过一次，处置是：内置层留作唯一，独立包卸掉。

**为什么它不在 `TARGETS` 里**：这个包**不修、不拦**——它没有补丁可打，作用只是「这个包名不该出现在 profile 里」。所以它落在 `lib/targets.js:67-79` 的 `DUPLICATES`，由 `duplicates()` 在启动时提醒一句。

**解法**：按三处核查该包是否回潮——profile 的 `package.json`（deps）、`bundles`、`node_modules`，**任一处命中即为回潮**，从三处一并摘掉后重装。想做防御就把它写进 `lib/targets.js` 的 `DUPLICATES` 之外再确认一次 `duplicates()` 有没有被启动流程调用（`package.json` 的 `files` 与 `index.js` 的初始化段）。

**验证方式**：重启后启动日志**不再**出现 `[patch-kit]` 对 maid-atelier 的提醒行；侧栏/立绘只有一层；视频层的路由回来（`video_understand` 相关的页面元素恢复）。

来源：`lib/targets.js:67-79`（`DUPLICATES` 定义与 2026-10-17 事件原委）、`lib/targets.js:86`（`duplicates()`）。

---

## 三、打补丁的常见失败

### 3.1 `git apply` 贴不上（上游动过那块代码）

**症状**：`upgrade` 打印 `✗ git apply 贴不上（上游多半改了那块代码）。`，并回显 `error: patch failed: <文件>:<行>`；紧接着打印 `临时目录留着没删：<staging>`。

**原因**：`upgrade` 用 `git apply` 试重放旧补丁，靠补丁自带的上下文定位。上游若改了被补的那几行，上下文对不上，git 就拒绝——**这是设计**（明确报出是哪个文件哪一段，而不是甩一个对不上的 diff）。

**解法**：按它给的路径手工核对 `node_modules/.pnpm_patches/<包>@<版本>/` 这棵树，把 `patches/` 里的补丁改到能贴（或直接在这棵树上手改完 `pnpm patch-commit`）。临时目录故意保留，别急着删。

**验证方式**：改完后 `git apply --check -p1 <补丁>` 退出码 0；再 `node --check` 过一遍被改的 `.m?js`；`verify` 全绿。

> 注：**本机尚未真正遇到过一次 `error: patch failed`**（2026-10-14 起的旧会话里该字符串零命中，此条来自代码分支与 README，具体现场（待核））。

### 3.2 暂存目录残留：`ERR_PNPM_EDIT_DIR_NOT_EMPTY`

**症状**：

```text
[ERR_PNPM_EDIT_DIR_NOT_EMPTY] The directory C:\Users\Kayle\.dsh\profiles\desktop\node_modules\.pnpm_patches\<包>@<版本> is not empty
Either run `pnpm patch-commit "C:\Users\Kayle\.dsh\profiles\desktop\node_modules\.pnpm_patches\<包>@<版本>"` to commit or delete it
```

**原因**：上一次 `upgrade` 跑到一半（git apply 失败、语法检查不过，或人工打断），`pnpm patch` 的暂存目录留下了。pnpm 拒绝往非空目录里再 patch 一次。

**解法**：二选一——确认这棵树就是要的结果，就 `pnpm patch-commit "<该目录>"` 收口；否则整个目录删掉，再重跑 `upgrade`。`patch.mjs` 的 upgrade 有幂等判断（发现这棵树已含补丁特征就跳过重放，直接 commit 收口），所以「上次跑了一半」通常不会贴第二遍。

**验证方式**：目录被清掉或已 commit；重跑 `upgrade` 不再报 `EDIT_DIR_NOT_EMPTY`；`verify` 全绿。

> 出处：这条报错是**同源兄弟仓 `dsh-maid-tts-fix` 的 upgrade 流程**实测（`dsh-xiaomi-tts：3.0.7 → 3.0.8`，2026-10-15）。patch-kit 的 `upgrade` 用同一套 `.pnpm_patches` 暂存逻辑（`scripts/patch.mjs:448`），所以判据与解法通用；patch-kit 自身是否撞过（待核）。

### 3.3 哈希对不上：补丁改过没重打，或 git 动了字节

**症状**：`verify` 打印

```text
✗ lockfile hash 与补丁正本不符
    正本：e09ed330c4e244254f1f3d39e27c14c6cd21b03ab110f7dc7a0bfc674a1d8aba
    锁内：<另一串 64 位 hex>
    → 补丁改过但没重打：node scripts/patch.mjs install
```

**原因**（两种，要分清）：

1. `patches/*.patch` 被编辑过，而 profile 里那份副本与 lockfile 里的 `patch_hash` 还是旧的——这是正常流程，重打一次即可。
2. **换行被转换**：`.patch` 的 sha256 就是 lockfile 里的 `patch_hash`，CRLF/LF 一换字节就变。本仓 `.gitattributes` 为此写了 `*.patch -text`（逐字节保持原样），其余文本 `* text=auto eol=lf`，`.sh` 强制 LF（CRLF 的 .sh 在 git-bash/WSL 下会一路报 `$'\r': command not found`）、`.cmd`/`.ps1` 强制 CRLF。生成补丁时也要显式关掉转换——同类仓实测用的是 `git -c core.autocrlf=false diff --no-color --no-ext-diff`。

3. **同族但更隐蔽的一种：直接改运行包内的 JS 时，CRLF 让改动静默 0 命中**。用 `ops_replace` / `edit` 去改 `node_modules/` 里的 `pack.js` / `client.js`，如果锚点字符串按 LF 写、目标文件是 CRLF，工具会报「命中 0 次」；而短单行锚点在两边都不报错、只是不生效。这类失败最费时间的地方在于「看起来什么都没发生」——逐字节比对后才发现差异全在行尾（`node -e "console.log(JSON.stringify(line))"` 或 `od -c`）。处置：把锚点写成不带换行的单行片段，或先统一行尾再改（操作前 `git config core.autocrlf` 归零）。**未验**：本条是从工具行为归纳的，没有留下「同一锚点 LF/CRLF 两版对照」的实测记录。

**解法**：情况 1 跑 `node scripts/patch.mjs install`（会同步 profile 里的补丁副本并重打）。情况 2 先查 `git config core.autocrlf` 与文件字节（`git diff --stat` 不该看到 `.patch` 有改动），必要时 `git -c core.autocrlf=false …` 重新生成补丁，再 install。

**验证方式**：`verify` 里 `✓ lockfile hash 与补丁正本一致：e09ed330c4e24425…`；机械核对是 `node -e` 算正本 sha256 与 `pnpm-lock.yaml` 里 `version: 0.5.2(patch_hash=…)` 相等。

### 3.4 文件被占用（EBUSY / 另一进程正在使用）

**症状**：—（本机 2026-10-14 起的旧会话里，`EBUSY`、`being used by another process` 在打补丁语境下**零命中**。）

**处置**：**暂未遇到**。真遇上时按常识先关掉正在跑的 DSH 与任何占着 profile 的 node 进程，再重跑命令；语义相近的一类实际故障是「目录残留」而不是「文件被占用」——见 3.2。此条（待核）。

### 3.5 路径变了（profile 名不是 desktop / 环境变量不生效）

**症状**：`找不到 <profile>\pnpm-workspace.yaml，profile 路径对吗？（用 --profile 指定）`，或体检报的 profile 明显不对（例如指向 `...\profiles\web`）。

**原因**：profile 解析兜底值是 `~/.dsh/profiles/desktop`；新设备上 profile 可能叫别的名字，或 `DSH_PROFILE_DIR` 指向了不存在的目录（**目录必须存在才会被采用**，否则静默落到兜底值）。

**解法**：显式指定——`node scripts/patch.mjs verify --profile C:\path\to\profile`；或先设 `DSH_PROFILE_DIR` 且确认它存在。`scripts/venv.mjs` 同样支持 `--profile`。

**验证方式**：命令回显的 `profile：` 一行就是它实际用的目录；与 `%USERPROFILE%\.dsh\profiles\` 下的真实目录名一致。

### 3.6 profile 的 `package.json` 带 UTF-8 BOM → 宿主 `JSON.parse` 抛错，桌面端启动即死

**症状**：桌面端**连启动都过不去**——桌面壳报 `DesktopHostFatalError`，关掉重启、重启机器都一样挂（不是偶发，是必挂）。`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-host.log` 里就是这一行原文：

```text
SyntaxError: Unexpected token '﻿'
```

单引号里那个字符是**看不见的**：U+FEFF，也就是 UTF-8 BOM，文本形式写作 `'\ufeff'`。用十六进制看 `package.json` 头三字节是 `EF BB BF`；在部分编辑器里它显示成一个 `﻿` 小方块，在终端里干脆什么都没有。报错栈与启动日志里能见到 `dsh-app-boot`、`readProfileManifest`、`JSON.parse` 这几个名字。实测（2026-10-13 21:49 ~ 2026-10-18 14:41）共出现 **16 次**；其中装完 `dsh-xiaomi-tts` 之后 05:25–05:28 连炸四次，每次都起不来。

**原因**：宿主启动器 `dsh-app-boot` 的 `readProfileManifest` 把 profile 下 `package.json` 的**文件原始内容直接丢给 `JSON.parse`**，不剥离 BOM。Node 的 `JSON.parse` 不认 U+FEFF——按 JSON 规范 BOM 不是合法 token，第一个字符就抛 `SyntaxError: Unexpected token '﻿'`，`readProfileManifest` 拿不到 manifest → 启动链断在这里 → `DesktopHostFatalError`。BOM 几乎总来自**写入侧**：Windows PowerShell 5.1 的 `Set-Content -Encoding UTF8` / `Out-File -Encoding UTF8` 默认加 BOM，某些编辑器勾了「带 BOM 保存」也一样。因此**任何「改 profile 的 package.json」的动作都是嫌疑犯**——装插件时写 `bundles`、手改 `cordis.yml` 周边、脚本批量改依赖，都在其中。**排查最容易走岔的地方**：PowerShell 的 `ConvertFrom-Json` 会吞掉 BOM、照常解析成功，于是人得出「文件没问题」的结论，把真因放跑（本条 lesson 的原文结论就是「排查时用 Node `JSON.parse` 而非 PS `ConvertFrom-Json`，PS 吞 BOM 掩盖真因」）。

**解法**：

1. **落盘一律 UTF-8 无 BOM。** Node 侧 `fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf8')` 不会写 BOM；PowerShell 侧别用 `Set-Content -Encoding UTF8`（PS 5.1 会加 BOM），改用显式无 BOM 的 .NET 写法：

   ```powershell
   [System.IO.File]::WriteAllText($p, $s, (New-Object System.Text.UTF8Encoding($false)))
   ```

2. **排查必须用 Node 的 `JSON.parse` 校验，不能用 PowerShell `ConvertFrom-Json`。** PS 吞 BOM 会掩盖真因，让人误判「文件没问题」；Node 的 `JSON.parse` 与宿主同款行为，它丢什么错，宿主就丢什么错。
3. **已知坑**：任何「改 profile `package.json`」的动作之后（装插件写 bundles、手改 `cordis.yml` 之类、脚本改依赖），都要**复验一次无 BOM**。桌面端不会在改的时候校验，只在下一次启动时炸——中间那段「一切正常」是假象。
4. 已经被写进 BOM 的处置：先按上面第 1 条把 BOM 剥掉（无 BOM 重写整个文件）再重启；若文件内容也已经被改坏，用 `.patch-backups/` 或 guard 快照恢复（见 4.1 / 4.3），恢复后照样复验无 BOM。

**验证方式**：

```bash
# ① 查 BOM（命令形态可直接跑）
node -e "const b=require('fs').readFileSync(process.argv[1]);console.log(b[0]===0xEF&&b[1]===0xBB&&b[2]===0xBF?'HAS BOM':'no BOM')" "C:\Users\<你>\.dsh\profiles\desktop\package.json"

# ② 用 Node 的 JSON.parse 校验（与宿主同款行为，必跑）
node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log('JSON OK')" "C:\Users\<你>\.dsh\profiles\desktop\package.json"
```

① 必须回 `no BOM`，② 必须回 `JSON OK`；② 报 `SyntaxError: Unexpected token '﻿'` 就是本条无疑。然后**重启桌面端**：宿主能起来、界面进得去，且 `crash-host.log` **没有新增行**（`Get-Item "$env:APPDATA\@deepseek-ai\dsh-desktop\logs\crash-host.log" | Select-Object LastWriteTime, Length` 的 mtime 不再变）。最后 `node scripts/patch.mjs verify` 全绿，确认这次改动没顺带弄坏别的。

**未验**：① 上面两行 `node -e` 命令的现场输出本机**未留存**（本条来自 crash 日志因果定位，不是重放）；②「PS 5.1 `Set-Content -Encoding UTF8` 加 BOM / `[System.IO.File]::WriteAllText` 不加 BOM」是文档行为，本机**未做对照实验**；③「修掉 BOM 后宿主一定能起来」**未验**（现场记录只到「定位到 crash-host.log 与 BOM 的因果」，无修复后重启记录）。

> 证据：记忆 lesson 0mv7779gn-96658fc535dd4fcf980bd932ec、会话候选 C6（出现 16 次，2026-10-13 21:49 ~ 2026-10-18 14:41）· 2026-10-18 补录

---

## 四、回滚与备份

### 4.1 打补丁 / 卸补丁前后的自动备份

**症状**：—（这是机制说明，不是故障。）

**原因**：`patch.mjs` 只在**真要改动**时备份：`install` 改动 `pnpm-workspace.yaml` 时，把 `pnpm-workspace.yaml` 与 `pnpm-lock.yaml` 各存一份到 `.patch-backups/`；`remove` 摘除登记前也存一份（tag `patchkit-remove`）。登记本就正确时不重写（避免无谓动 mtime，让人误以为「补丁刚被改过」）。

**解法**：恢复时把 `.patch-backups/` 里的 `*.bak-patchkit-<stamp>` 复制回 profile 原文件名，再 `pnpm install`。当前机器上躺着两代：

```text
.patch-backups/pnpm-workspace.yaml.bak-patchkit-20261014161717
.patch-backups/pnpm-lock.yaml.bak-patchkit-20261014161717
.patch-backups/pnpm-workspace.yaml.bak-patchkit-20261014203538
.patch-backups/pnpm-lock.yaml.bak-patchkit-20261014203538
```

**注意**：`.patch-backups/` 在 `.gitignore` 里——它是**这台机器**的环境状态，不是本仓内容，clone 到新机器毫无意义。

**验证方式**：备份文件与 profile 里的同名文件（`diff` 或比对 sha256）在改动前后符合预期。

### 4.2 卸掉补丁（回退到纯上游）

**症状**：—（操作说明。）想临时验证「这个 bug 是上游的还是补丁带来的」，或准备彻底离开本仓时用。

**解法**：`node scripts/patch.mjs remove`——从 `patchedDependencies` 摘掉登记、删掉 profile 里的补丁副本（先存一份备份），再跑 `pnpm install`。`--dry-run` 只说要做什么，不落盘。之后重启 DSH。接管类（`guard/`）不受 patch.mjs 管：反向操作即可——从 `dependencies` 删掉 `"dsh-maid-guard": "link:…"`、从 `bundles` 里去掉名字，再 `pnpm install`。

**验证方式**：`pnpm-workspace.yaml` 里没有那条 `patchedDependencies`；`profile/patches/` 下补丁文件已删；重启后 `[patch-kit]` 的体检会报「未登记」，属预期；`pnpm-lock.yaml` 里不再有该包的 `patch_hash=`。

### 4.3 整个 profile 回滚（guard 的快照）

**症状**：装完某个插件 DSH 起不来，或某个插件把 profile 弄坏了，需要退回上一个能用的状态。

**原因**：`dsh-maid-guard`（原 `dsh-plugin-guard`）在装插件前会自动存一份 `auto-before-install` 快照：`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml` 五个文件 + `manifest.json`。

**解法**：

```bash
node guard/scripts/guard-cli.js list --profile desktop        # 列快照
node guard/scripts/guard-cli.js snapshot --profile desktop    # 手工存一份
node guard/scripts/guard-cli.js status                        # 健康 + 待处理事故
node guard/scripts/guard-cli.js quarantine --list             # 看被隔离的插件
node guard/scripts/rollback.cmd                               # 一键回滚（Windows）
```

快照目录：`~/.dsh/rollbacks/<profile>/<stamp>/`（本机桌面端已有两份）。装崩了还能把肇事插件**隔离**掉先让 DSH 起来。

**验证方式**：`guard-cli.js status` 打印健康端口与待处理事故；`~/.dsh/guard/logs/` 下有 `boot-*.log` / `server-*.out.log` / `incident-*.md`。

### 4.4 一份补丁里混了两个目标，最后只能整份清掉（ego-browser 侧边栏美化，2026-10-15）

- **症状**：本只想修「Windows profile 锁」（issue#70）这一件事，结果同一份 `.patch` 里越塞越多，涨到 45 KB 后装上出现多处非预期界面改动（配色、金框、生成背景图一起进来）；等意识到不对，已经没法只摘掉美化那部分。老大最后的要求是「直接全清掉，回到最开始的默认」，并补一句「清掉的是做右边侧栏 UI 主题界面那些噢」。
- **原因**：五轮美化提交（`1a1f6f5` / `a454489` / `b124571` / `b62c8de` / `52bc0e0`）把配色改造、`maid-atelier` 素材复用、金框、生成背景图全塞进了同一份 `.patch`，与「只修 profile 锁」的目标混在一个交付物里。**目标一混，撤回就得整份回退**——补丁是按文件整份替换的，没有「只摘一部分」这个操作。
- **解法**：`lib/client.js` 回到 0.8.6 原版（`163276` 字符）；补丁缩回 3.5 KB / 1 文件（sha256 `30a2fcff…`），只保留 issue#70 的修复；`chrome.mjs` 里保留 `killWindowsProfileOwners`；美化版整份归档到 `_probe/ego-patch-archive-2026-10-15/`（留证据，不从历史里消失）；新增 `_probe/patchgen-ego/mkpatch-issue70.mjs` 专用于生成这一份最小补丁。
- **验证方式**：提交正文记录重打后补丁 sha256 与最初版一致；`lib/selfcheck.js` 里 ego 段判据缩至 1 条（只核 issue#70 的那个行为）。
- 证据：提交 `f7ea1a0`（`revert(ego-browser): 撤回侧边栏 UI 主题美化，只留 issue#70 修复`，2026-10-15 04:36），diff 为 `patches/dsh-ego-browser@0.8.6.patch` −289 行、`lib/selfcheck.js` −31 行。
- **教训**：一份补丁只做一件事。美化、素材复用这类「可选项」一旦和 bug 修复进同一个文件，撤回成本就从「改几行」变成「整份回滚 + 重新取证 + 归档留痕」。

---

## 五、关键路径与配置落点

| 路径 / 键 | 内容 |
|---|---|
| `patches/dsh-video-understand@0.5.2.patch` | 补丁正本（21313 字节）。sha256 必须与 lockfile 里的 `patch_hash` 相等 |
| `lib/selfcheck.js` → `APPLIED_MARKERS` | 落盘判据，11 条特征串，覆盖 `dsh/index.js`、`engine/understand_video.py`、`engine/stages.py`、`engine/visual_level.py`、`engine/avis.py`、`engine/requirements.txt`、`engine/requirements-layer.txt` |
| `lib/targets.js` → `TARGETS` | 目标台账三态：`patched`（打补丁）/`forked`（整包接管）/`watch`（只登记待命） |
| `<profile>/pnpm-workspace.yaml` → `patchedDependencies:` | 登记：`dsh-video-understand@0.5.2: patches/dsh-video-understand@0.5.2.patch`（本机同文件里还有兄弟仓的一条 `dsh-xiaomi-tts@3.0.8`） |
| `<profile>/pnpm-workspace.yaml` → `minimumReleaseAgeExclude:` | 供应链门禁豁免名单（见 1.3） |
| `<profile>/pnpm-lock.yaml` | `version: 0.5.2(patch_hash=e09ed330…)`——hash 落点 |
| `<profile>/patches/` | 补丁副本（profile 里那一份才是 pnpm 真正读的） |
| `<profile>/node_modules/dsh-video-understand/.venv/` | Python 运行时，重铺就没（见 1.4） |
| `.patch-backups/` | 本机 profile 配置备份（不进版本控制） |
| `~/.dsh/rollbacks/<profile>/<stamp>/` | guard 快照（见 4.3） |
| `~/.dsh/guard/config.json` | `keepSnapshots`（默认 10）与可选 `port` |
| `~/.dsh/guard/{logs,pending-incident.json,quarantine.json}` | 日志 / 待处理事故 / 隔离记录 |
| `D:/DeepSeek Harness/resources/runtime/pnpm/bin/pnpm.cjs` | 本仓用的 pnpm（存在就用它，否则退回 PATH 上的 `pnpm`） |
| `%APPDATA%\@deepseek-ai\dsh-desktop\logs\` | 桌面端宿主日志落点（本机只见到 `crash-*-host.log` / `crash-*-web-boot.log`，常规启动日志是否落盘（待核）） |

环境变量：`DSH_PROFILE_DIR`（patch-kit 与 venv.mjs 认它找 profile）；`DSH_GUARD_PROFILE` / `DSH_GUARD_PORT` / `DSH_GUARD_PNPM` / `DSH_GUARD_NODE` / `DSH_GUARD_LAUNCH`（guard 侧）。

插件入口：`package.json` 的 `dsh.bundle.patch = ./cordis.patch.yml`，向 bundle 插一行 `id: patch-kit, name: dsh-maid-patch-kit`；`index.js` 导出 `name = 'patch-kit'`、`inject = []`（无必需服务，纯启动体检，不注册路由、不依赖 settings）。

---

## 六、排查手法

### 6.1 三条命令定性

```bash
node scripts/patch.mjs list      # 本仓有什么补丁 / 接管 / 观察目标，版本是否吻合
node scripts/patch.mjs verify    # 只核对：登记、hash、落盘字节（只读，最安全的第一手）
node scripts/venv.mjs --verify   # 只看 .venv 状态，不动手
```

`verify` 的输出就是判据本身：逐行 `✓/✗`，末尾「全部核对通过。」或「有未通过项，见上」外加一行行说明。**任何先问「补丁还活着吗」的场合都先跑它**，别先猜。

### 6.2 不重启也能确认插件在宿主里是活的

按宿主同款入口手调一次装配（实测做法）：用 `import()` 加载 `index.js`，确认 `name = patch-kit`、`inject = []`（空数组）、`apply` 是函数 = true，再拿一个假 `ctx`（只需 `logger.warn/info`）调 `apply({ logger })`，看它打印的是 `[patch-kit] 补丁齐备：…` 还是逐条 warn。它**永不抛**——最致命的失效方式不是功能坏，而是 `apply()` 抛错把整个 profile 拖下水。

### 6.3 看日志

- 宿主：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\`，挑最新的 `host.log` / `web-boot.log` 找 `[patch-kit]` 与 `[dsh-maid-guard]`。
- guard：`~/.dsh/guard/logs/` 的 `boot-*.log`、`server-*.out.log`、`server-*.err.log`、`incident-*.md`。
- 历史会话原文（含当时的终端输出）：`$DSH_HOME/sessions/<工作区>/<会话id>/session.jsonl.zstd`，是 zstd **帧流**，用 `node:zlib` 的 `zstdDecompressSync` 逐帧解（系统上没有 zstd CLI）。这条在本次查证里用过，是本仓最靠谱的「现场记录」。

### 6.4 接管包自测

```bash
node guard/scripts/smoke-test.js     # 快照/回退/解析 16 项，末行 ALL PASS
node guard/scripts/load-drill.js     # 宿主加载演练 13 项，末行 ALL PASS
```

两者都在临时目录里造 `DSH_HOME` 跑，不碰真实快照。

`load-drill.js` 专门验两件事：`apply()` 在「什么都拿不到」和「服务齐全」两种情况下都不抛；pre-tool 钩子**真留下了** `auto-before-install` 快照，且存档失败时钩子仍静默（安全网不能反过来堵死安装）。

### 6.5 改补丁时的纪律（照做能省一次翻车）

1. 改完 `patches/*.patch` 就跑 `install`（同步副本 + 重打 + 登记 hash）。
2. 补丁内容改了，**同步改** `lib/selfcheck.js` 的 `APPLIED_MARKERS`——判据不跟着改，体检就会说谎。
3. 新增特征串挑**只在补丁里出现**的字符串（`_gateway_config`、`PYTHONUTF8`、文件头 BOM 都属于此类）；`type: 'string'` 这种上游本来就有的写法不能当判据（原版里有 18 处）。
4. 动手前后各存一次档（`guard-cli.js snapshot`），别在没退路的时候试。

### 6.6 给「所有插件」做批量改动时，别只按仓目录列——漏掉子目录里的接管包

**症状**：2026-10-16 给八个小困插件统一换面板图标，七个仓根目录的都换好了，插件面板里 `dsh-maid-guard` 依然是默认蓝蝴蝶。老大照截图一眼逮住。

**原因**：`dsh-maid-guard` **不住在仓根目录**，它住在本仓的 `guard/` 子目录（profile 侧走 `link:` 软链挂载，见 1.2/1.5）。按「八仓目录」逐个加图标，子目录里的包天然不进枚举。同型漏网还出现在 package.json 的 `files` 白名单上——不把 `assets/plugin-icon.png` 列进去，npm 分发时图标会被打包排除，换机器就掉图。

**解法**：枚举小困插件**一律走文件系统真值，不走目录印象**：

```bash
find . -maxdepth 3 -name package.json -not -path "*/node_modules/*" -not -path "*/.git/*"
```

对每个结果读 `icon` 字段判断是否漏。当前实况是**「八个仓 + 一个子目录包」**（guard 是 patch-kit 接管上游 `dsh-plugin-guard` 更名而来，独立 package.json 与版本号 `0.3.2-fork.N`）。补齐三处：图标文件、`"icon": "assets/plugin-icon.png"`、`files` 白名单加入该路径。

**验证方式**：`node -e "const p=require('./guard/package.json');console.log(p.icon,p.files.includes('assets/plugin-icon.png'))"` 两项都为真；`pnpm pack --dry-run --config.ignore-scripts=true` 的 Tarball Contents 里出现 `assets/plugin-icon.png`；重启 DSH 后面板该图标已换（图标是启动时读的）。

### 6.7 巡检报「缺这一节」时，先看文件是不是在两次运行之间被改过

- **症状**：巡检脚本报某本册子缺某一节；紧接着手工 `grep` 同一本册子，**命中 0 次**，差一点据此判定「这条从来没写过、需要补录」。再跑一次巡检，判定却翻转成「已登记」。
- **原因**：文件在两次运行之间被改写——04:00 那次写入把这一节补进了册子，而手工 `grep` 用的是更早的读取快照（或相反：读发生在写之前）。`grep` 命中的是「跑那一刻的文件」，不是「你以为的那个版本」，两次观测之间没有任何一致性保证。
- **解法**：定性之前先看两个真值：`Get-Item <册子> | Select-Object LastWriteTime`（写时间晚于本次巡检开始时刻 = 已有结论作废）、`git diff --stat -- <册子>`（有未提交改动 = 手上读的不是已登记版本）。两者都干净，再拿同一时刻的读取结果下结论。
- **验证方式**：记忆 `0mvctoud1-4e4ebc50fa054005ac70e31bc0` 记录的原案——先看 `LastWriteTime` 发现 04:00 有写入，与 `git diff` 对照后判定翻转，避免了一次重复补录。
- 证据：记忆 `0mvctoud1-4e4ebc50fa054005ac70e31bc0`（patch-kit，巡检方法论）；2026-10-18 复核。
- **教训**：「两次工具调用结果不一致」通常不是工具坏了，是其中一次读到的是旧状态。取证类任务里，每次下判断前都要先锚定版本。
