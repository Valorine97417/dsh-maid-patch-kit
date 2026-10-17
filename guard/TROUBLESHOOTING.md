# dsh-maid-guard · 问题与解决记录

> 用途：本包（`dsh-maid-patch-kit/guard/`，上游 `lxzy-7/dsh-plugin-guard` v0.3.2 的桌面端接管分支）在**新设备上安装、迁移、重装**时的参考。母仓通用问题见 [`../TROUBLESHOOTING.md`](../TROUBLESHOOTING.md)，本册只收 guard 自己的坑。
> 每条按「症状 → 原因 → 解法 → 验证方式」写，症状照抄实测报错。只在有据可查时下结论，不确定的标「（待核）」。
> 素材来源：本包源码与注释（`index.js`、`client.js`、`src/{layout,profile,engine,incident,tools}.js`、`scripts/*`）、`README.md`、`README.upstream.md`、母仓事故单 1.5/4.3/6.4/6.6、记忆库与会话终端输出。
>
> 最后更新 2026-10-18（本包 `0.3.2-fork.2`，宿主基线 DSH 0.2.0-rc.2 / 桌面端）

本机基线（写文档时实查，供对照）：

| 项 | 值 |
|---|---|
| 包名 / 版本 | `dsh-maid-guard` / `0.3.2-fork.2` |
| 正本目录 | `dsh-maid-patch-kit/guard/` |
| 上游 | `lxzy-7/dsh-plugin-guard` v0.3.2，最后提交 `c95036f`（2026-08-18），此后零提交 |
| profile 接入 | `dependencies: { "dsh-maid-guard": "link:<本仓>/guard" }` + `dsh.profile.bundles` 加 `dsh-maid-guard` |
| 默认 profile / 端口 | `desktop` / `19387`（运行期由 `dsh-desktop-host` 传入，不可写死） |
| 数据落点 | `~/.dsh/rollbacks/<profile>/<stamp>/`、`~/.dsh/guard/{config.json,logs/,pending-incident.json,quarantine.json}` |
| 自测 | `node guard/scripts/smoke-test.js`（16 项）、`node guard/scripts/load-drill.js`（13 项），末行均应为 `ALL PASS` |

---

## 一、安装与部署

### 1.1 装上了，设置页那块「备份管理」永远不出现，也不报任何错

**症状**：`dsh-maid-guard` 装完重启，设置页里找不到「备份管理」栏；日志里没有 error，也没有 warning。用 `node guard/scripts/guard-cli.js status` 反倒能看到健康信息——宿主半是活的，只有客户端半边不见了。

**原因**：客户端半边的 `exports.inject` 挂了 rc.2 已删除的服务名，整个客户端半边永远 pending。上游原版写的是 `['slots', 'settingsScope']`（`lib/client.js`），而 `settingsScope` 服务与 `settings.plugin.item` 槽位在 DSH 0.2.0-rc.2 里已经被整个移除；`package.json` 的 `dsh.client.inject` 还声明了 rc.2 根本不存在的 `@deepseek-ai/dsh-client-runtime`，连宿主半都进不去。

**解法**：`client.js:375` 收窄成 `exports.inject = ['slots']`（`slots` 是 rc.2 与 rc.7 都有的核心服务）；`settingsScope` 改成 `ctx.get('settingsScope')` 软探测（`client.js:349`），有才挂配置卡、没有就安静跳过；两条真正还在的槽位保留——`shell.overlay`（`client.js:329`，启动心跳）与 `settings.section`（`client.js:338`，设置页「备份管理」）。`package.json` 的 `dsh.client.inject` 同步删掉 `@deepseek-ai/dsh-client-runtime`。

**验证方式**：重启后设置页出现「备份管理」栏；`~/.dsh/guard/logs/` 下能看到 `boot-*.log`；`GET /guard/api/state` 返回 200 而不是 401/404。

### 1.2 整个插件加载失败，profile 里其它插件跟着不进

**症状**：装上后 DSH 起不来或起一半插件全丢，启动日志里有 `Cannot find package '@deepseek-ai/schemastery'` 之类的加载错误。

**原因**：上游 `index.js` 顶层是 `import z from '@deepseek-ai/schemastery'`——静态 import 一旦解析不到，**整个插件**加载失败，而启动阶段失败会连累同一个 profile 的其它插件。

**解法**：`index.js:24` 的 `loadSchema()` 改**动态可选加载**——先试 `@deepseek-ai/schemastery`，再试裸名 `schemastery`，都失败就返回 `null` 并跳过设置注册，插件主体照常工作。

**验证方式**：`node guard/scripts/load-drill.js` 末行 `ALL PASS`；在桌面端 profile（`node_modules/@deepseek-ai` 是空目录、裸名只有 `schemastery`）下重启，插件仍出现在已加载列表里。

### 1.3 设置注册抛错被吞掉，`keepSnapshots` 在界面上没处改

**症状**：`settings.register('guard', ...)` 那条路从来没生效，配置卡不存在，只能手改 `~/.dsh/guard/config.json`。

**原因**：rc.2 的 `SettingsForms` 只暴露 `configure/describe/update/...`，**没有 `register()`**——原版直接调用必然抛错，而外层 `try/catch` 把它吞了，所以既不生效也不报错。

**解法**：`index.js:272-281` 的 `ctx.inject(['settings'], ...)` 改成软探测：`typeof settings.register !== 'function'` 就直接安静 return；`index.js:278` 只有在 `loadSchema()` 拿到 schema 时才注册。rc.2 上改保留份数走设置页「备份管理」里的输入框或 `guard-cli.js keep`（`index.js:178-179` 那条 `guardSettingsScope.update` 只有 rc.7 才命中）。

**验证方式**：`node guard/scripts/guard-cli.js keep --set 10` 后 `cat ~/.dsh/guard/config.json` 看到 `keepSnapshots: 10`；重启无异常。

### 1.4 回滚接口翻的是一个不存在的 profile

**症状**：不指定 profile 调回滚/列表，报找不到 profile 或列出零个快照；显式传 `--profile desktop` 才有内容。

**原因**：上游默认 profile 写死 `'web'`（`src/index.js:85`、`src/tools.js:183`、`src/incident.js:210/218`、`scripts/guard-cli.js:172` 五处），而桌面端的 profile 叫 `desktop`。

**解法**：新增 `src/profile.js` 收拢全部环境知识——`detectProfile(explicit)` 依次尝试：显式参数 → `DSH_GUARD_PROFILE` → `DSH_PROFILE_DIR` 的目录名 → `profiles/desktop` → `profiles/web` → 排序后第一个 → `'desktop'`；宿主半、CLI、`boot-guard.*` 共用它，谁也不再写死 profile 名。

**验证方式**：`node guard/scripts/guard-cli.js profiles` 能列出 `desktop`；不带 `--profile` 跑 `list` 能看到 desktop 的快照。

### 1.5 健康检查永远报「服务未就绪」

**症状**：DSH 明明开着，`status` / `health` 却一直说不健康，守护脚本因此反复回滚。

**原因**：上游健康检查端口写死 `3080`，桌面端真实端口是运行期由 `dsh-desktop-host` 传进来的 **19387**（且可能变），写不进代码。

**解法**：`detectPort(configured)` 依次 `DSH_GUARD_PORT` → 配置里的显式值 → `19387`；`portCandidates(configured)` 返回 `[DSH_GUARD_PORT?, 配置值, 19387, 3080]` 去重后供逐个试（`src/profile.js`）；`incident.js:164` 的 `probeHealth(port = null)` 不给端口就按候选逐个试，返回 `{ port, healthy, tried }`。`readGuardConfig()` 的默认 port 从 `3080` 改为 `null`（`null` = 交给探测器），`writeGuardConfig()` 只在 port 有效时才落盘该字段。

**验证方式**：`node guard/scripts/guard-cli.js health` 打印命中端口与全部被排除的候选；`status` 在 DSH 运行时返回健康。

### 1.6 端口找对了，健康检查还是判死——因为根路径回 401

**症状**：探测 19387 时拿到 `401`，被判成不健康，守护脚本把好好的环境回滚掉。

**原因**：桌面端根路径要鉴权 token，`GET /` 不带 token 返回 **401**；把 200 当唯一健康判据就会误杀。

**解法**：`incident.js:148` 的判据放宽成 `statusCode >= 200 && statusCode < 500`——**401 也算活**。`scripts/boot-guard.ps1:134` 的 `Test-PortHealth()` 同理：`Invoke-WebRequest` 遇 401 会**抛异常**，必须从 `$_.Exception.Response.StatusCode` 把码读出来再判。

**验证方式**：DSH 运行时 `node guard/scripts/guard-cli.js health` 命中 19387 且判健康；`guard-cli.js status` 不再报「服务未就绪」。

### 1.7 自带依赖在桌面端解析不到，插件直接废掉

**症状**：`Cannot find package 'js-yaml'`，插件加载失败。

**原因**：上游用 `js-yaml` 解析 `cordis.patch.yml`。桌面端 profile 的 `node_modules/@deepseek-ai` 是**空目录**、裸名只有 `schemastery`，第三方依赖不保证解析得到。

**解法**：**去掉唯一运行时依赖**，换成内置的行解析器 `parsePatchEntries()`（`src/engine.js:105`）+ `yamlScalar()`，够解析 `cordis.patch.yml` 的 `- id:` / `name:` / `insert:` 三项并剥行尾注释。现在本包**零外部依赖**，任何 pnpm 布局都能加载。

**验证方式**：`node guard/scripts/smoke-test.js` 里的“解析”用例全绿；`node guard/scripts/guard-cli.js snapshot --profile desktop` 能正确识别 profile 里已装的插件行。

### 1.8 `link:` 接进去之后重启没生效

**症状**：`package.json` 加了 `"dsh-maid-guard": "link:<本仓>/guard"`、`dsh.profile.bundles` 也加了名字，重启后 guard 的六条路由还是 404。

**原因**：改了 `package.json` 但没跑 install，`node_modules` 里没有链接；或只加了 `dependencies` 没加 `dsh.profile.bundles`（bundles 决定它被不被加载）。

**解法**：两处都改完在 profile 目录里跑 `pnpm install`；`cordis.patch.yml` 里那一行必须是 `- insert: [{ id: guard, name: 'dsh-maid-guard' }]`——**id 保持 `guard` 不变**（事件/路由前缀靠它），`name` 指向接管后的包名（旧名字在本仓不存在）。重装/删除走反向操作。

**验证方式**：`GET /guard/api/state` 返回 200；`~/.dsh/guard/` 目录被创建；重启后 `cordis.yml` 里能看到 `guard` 那一行（本机曾验到 `cordis.yml:1584`）。

### 1.9 「给所有插件做同一件事」时 guard 总是被漏掉

**症状**：统一图标、统一事故单、统一版本号这类批量任务做完，guard 没跟上——它不住在任何仓的根目录，而在 `dsh-maid-patch-kit/guard/` 子目录里，单独一套 `package.json` 与版本号（`0.3.2-fork.N`）。

**原因**：枚举只数了仓目录（`ls` 顶层 / 只看 `dsh-maid-*` 仓库），没扫子目录里的 `package.json`。2026-10-16 加图标时就是这样漏掉它的，被照截图逮住。

**解法**：枚举一律走 `find -maxdepth 3 -name package.json -not -path "*/node_modules/*"`（或从远端 `GET /user/repos?affiliation=owner` 与 profile `node_modules` 软链交叉核对）。当前小困插件实为「八个仓 + 这一个子目录包」，`dsh-maid-` 前缀即算小困插件。

**验证方式**：跑一遍上面的 `find`，输出里必须同时出现 `dsh-maid-patch-kit/package.json` 与 `dsh-maid-patch-kit/guard/package.json`；批量任务收尾时按这份清单逐项对账。

---

## 二、快照与回滚

### 2.1 回滚成功了，装坏的插件还在

**症状**：`dsh_rollback` 报成功、配置文件也回去了，但那个坏插件重启后依然被加载。

**原因**：快照只拷**五个文件**——`package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml`（`SNAPSHOT_FILES`，`src/layout.js`；`cordis.yml` 在列是因为 MCP 配置在里面）。`node_modules` 里的实际代码**不在快照范围内**，profile 回滚撤不掉已经被写进 `node_modules` 的包体。

**解法**：回滚默认会接着跑 `pnpm install --frozen-lockfile`（`src/engine.js:602`）把 `node_modules` 拉回锁文件状态；只想动配置、不动依赖时加 `skipInstall: true`（`dsh_rollback` 的 `skipInstall` 参数）。DSH 本体升级造成的版本跃迁回滚撤不掉，事故报告里会单独标「DSH 版本变化⚠️」段提醒。

**验证方式**：回滚后 `dsh_rollback action=status` 报健康；事故报告 `~/.dsh/guard/logs/incident-<ts>.md` 里 profiles 与最近良好快照的 sha256 逐文件对比应全为一致。

### 2.2 想手动钉一个状态，结果没生成新快照

**症状**：连着拍两次 `dsh_snapshot`，快照列表只多一条；返回里带 `skipped: true`。

**原因**：`snapshotMatches()`（`src/engine.js:417`）会把新目录与最新那份逐文件比 sha256，完全相同就删掉新目录并返回 `{ skipped: true }`（去重，`src/engine.js:481`）——这是设计行为，不是出错。

**解法**：确实要留一份同内容快照时传 `force: true`（`dsh_snapshot` 的 `force` 参数）。

**验证方式**：`dsh_rollback action=list` 能看到两条同内容快照；`manifest.json` 里 `tag` / `reason` 分别记着你写的那两句。

### 2.3 快照越堆越多，盘和时间都被吃掉

**症状**：`~/.dsh/rollbacks/<profile>/` 下几十份快照，`~/.dsh/guard/logs/` 里日志也堆成山。

**原因**：默认只保留 `DEFAULT_KEEP_SNAPSHOTS = 10` 份、`DEFAULT_KEEP_LOGS = 30` 份（`src/engine.js:22`），但历史版本留下的、或调大过 `keepSnapshots` 之后没调回来的会一直堆着；`pruneGuardArtifacts(keep = 30)`（`src/engine.js:520`）按五组各自保留最新 N。

**解法**：`node guard/scripts/guard-cli.js keep --set <N>` 改保留份数，允许范围 `MIN_KEEP_SNAPSHOTS = 2` ~ `MAX_KEEP_SNAPSHOTS = 100`（越界会被夹回）；再跑一次 `snapshot` 就会触发清理。

**验证方式**：`ls ~/.dsh/rollbacks/desktop | wc -l` 落在设定值附近；`~/.dsh/guard/logs/` 的每种前缀各不超过 `keep` 份。

### 2.4 卸掉插件后 `node_modules` 里留下一条指不到地方的链接

**症状**：profile 的 `node_modules` 里有条目指向已被删掉的目录，install 时报错或安装结果诡异。

**原因**：`link:` 依赖在插件目录被移走后会变成悬空链接。上游没有清理逻辑。

**解法**：每次 `pnpm install` 之后跑 `cleanupStaleBundleLinks(profile)`（`src/engine.js:634`）——只删 `target` 落在 `node_modules` **之外**、且已经不存在的那类悬空 link；**绝不删目标目录，也绝不碰 `.pnpm` 内部链**。

**验证方式**：`src/engine.js:607` 那条清理会返回被删条目列表；再跑 `pnpm install` 不再报错，`node guard/scripts/load-drill.js` 仍 `ALL PASS`。

### 2.5 手写快照 id 被拒

**症状**：`guard-cli.js` 或内部调用传入的快照 id 被判非法、直接不动作。

**原因**：`PATCH_ID_RE = /^[a-z0-9@/._-]+$/i`（`src/engine.js:247`），且额外禁止出现 `..`——这是防目录穿越的硬边界。

**解法**：id 只用字母数字与 `@ / . _ -`，不带空格、不带中文、不带 `..`；要引用某份快照用 `action=list` 打出来的 stamp 前缀。

**验证方式**：`node guard/scripts/smoke-test.js` 里对应用例通过；换成合法 stamp 前缀后 `rollback` 正常命中。

---

## 三、事故检测与隔离

### 3.1 崩过一次，重启后小困却不知道要分析

**症状**：某次启动失败被回滚了，但下一个会话里小困完全没提这件事。

**原因**：告警靠 `~/.dsh/guard/pending-incident.json` 这个待处理标记 + systemPrompt 注入。标记没写成、或被当成已处理，会话就收不到警报。

**解法**：事故发生时 `buildIncidentReport()`（`src/incident.js:174`）会写 `incident-<ts>.md` 并落 pending 标记，`incidentSectionText()`（`src/incident.js:98`）把它注入 systemPrompt 的 `guard:incident-alert` 段（order `-50`），隔离事故与普通事故两套文案。分析并修完之后调 `incident_resolved` 工具——它把 pending 重命名成 `resolved-incident-<ts>.json`（`resolveIncidentMarker()`），后续会话不再收到警报。

**验证方式**：`node guard/scripts/guard-cli.js status` 会打印待处理事故；`ls ~/.dsh/guard/` 里 `pending-incident.json` 消失、出现 `resolved-incident-<ts>.json` 即已标记处理。

### 3.2 插件把页面渲染崩了，但健康检查说一切正常

**症状**：DSH 服务起来了、端口也通，界面却是黑屏/白屏，守护脚本判定「健康」，不回滚。

**原因**：客户端渲染失败时服务端仍返回 200；纯 HTTP 探活看不出黑屏。

**解法**：`index.js` 里用进程内内存标志 `guardClientBooted` / `guardRenderError` 配合 `/guard/api/booted`、`/guard/api/render-error` 两条路由做黑屏检测；`scripts/boot-guard.ps1:218` 的 `Test-RenderReady()` 起服后轮询 `render-error`，`Confirm-RenderReady()`（:257）确认客户端真的渲染过。上游 v0.3.1 起就是这个思路。

**验证方式**：故意装一个会崩客户端的插件跑 `boot-guard.ps1`，日志里应出现回滚动作；正常启动时 `render-error` 返回空、`booted` 为 true。

### 3.3 回滚也没救回来——DSH 升级把插件打得不兼容了

**症状**：回滚到上一份良好快照、重试一次仍然起不来，守护脚本最终报 `FAILED`。

**原因**：这类失败不是配置被改坏，而是宿主升级后某插件与新版本不兼容，回滚配置根本治不了。

**解法**：v0.3.2 起 `boot-guard.ps1` 在「回滚 + 重试都失败」后走隔离链路——`Invoke-Guard @("quarantine","--diagnose")` 从启动日志里诊断肇事插件（`extractFailedPluginNames()` 认 `failed to <stage> loader entry <id> (<name>):` 与 `plugin(s) failed to load: A, B` 两种形态），再 `quarantine --plugin <culprit>` 给它追加 `disabled: true`，最后**不带它**起一次；成功则状态写 `QUARANTINED` 并说明怎么恢复。日志解析不出肇事者时保留失败报告（状态 `FAILED`），不乱隔离。

**验证方式**：`node guard/scripts/guard-cli.js quarantine --list` 看被隔离记录（落 `~/.dsh/guard/quarantine.json`）；恢复用 `dsh-guard quarantine --undo <id>`，DSH 应能正常启动。

### 3.4 日志里明明是中文乱码，报告却读不到关键报错

**症状**：Windows PowerShell 5.1 写出来的 `server-*.err.log` 是 ANSI/GBK，按 UTF-8 读出来全是 ``；事故报告里那 80 行 stderr 等于废的。

**原因**：老版本 PowerShell 默认按 ANSI 输出，日志编码不统一。

**解法**：`decodeTextRobust(buf)`（`src/incident.js:22`）先剥 UTF-8/UTF-16 BOM，先按严格 UTF-8 解，失败再按 GBK 兜底；`readPending()` 同样容 BOM。

**验证方式**：拿一份 GBK 编码的旧 `server-*.err.log` 跑 `dsh_rollback action=incident`，生成的 `incident-<ts>.md` 里中文应可读。

### 3.5 上游同名包装错了，行为对不上

**症状**：装的是「dsh-plugin-guard」，但界面/行为和本文档描述的不一致，或者干脆起不来。

**原因**：npm 上有**两个同名流转**——`wuweilab`（wuwei6666，带 Plugin Guard 标签页）与 `lxzy-7`（本包的上游）。本机走的是 `lxzy-7`，且已整包接管、**原版不安装**。

**解法**：只用本仓的 `dsh-maid-guard`（`link:` 到 `guard/`），不要再装任何 `dsh-plugin-guard`；供应链门禁（`minimumReleaseAge`）拦下来时不要用 `--config.minimumReleaseAge=0` 硬装别人的包——那条口子只在打自己补丁时用。

**验证方式**：`node -e "console.log(require('./package.json').name, require('./package.json').version)"` 在 `guard/` 下应打印 `dsh-maid-guard 0.3.2-fork.2`；profile 的 `node_modules` 里不应存在 `dsh-plugin-guard`。

---

## 四、守护启动脚本（`scripts/`）

### 4.1 `boot-guard.ps1` 在桌面端起不来

**症状**：跑守护脚本后弹出一个命令行窗口然后什么都没有，或一直等不到健康。

**原因**：上游按网页版写死 `dsh web` 启动；桌面端没有这个形态。

**解法**：`scripts/boot-guard.ps1` 改成「根目录有 `DeepSeek Harness.exe` 就起桌面壳（无参数），没有才退回 `cmd.exe /d /s /c "<root>\node_modules\.bin\dsh.cmd" web`」；`$Port = 0` / `$Profile = ""` 表示自动探测。`Test-HarnessShell()`（:155）负责判断该走哪条。

**验证方式**：在桌面端根目录跑 `powershell -File guard/scripts/boot-guard.ps1`，`~/.dsh/guard/logs/boot-*.log` 里出现健康判定与命中的端口。

### 4.2 pnpm 命令在 Windows 上找不到

**症状**：回滚/install 那一步报 `'pnpm' is not recognized`，或 cmd 报找不到命令。

**原因**：`cmd.exe /c` 对自己解析路径的方式敏感——给裸命令名加引号会让它**跳过 PATH 查找**。

**解法**：`cmdToken(s)`（`src/engine.js:390`）只在含空白或引号时才加引号，裸名一律不加；`runPnpm()`（:400）在 Windows 上走 `cmd.exe /d /s /c`，超时 10 分钟；`resolvePnpmCommand()`（:365）按 `DSH_GUARD_PNPM` → 探测顺序找可执行文件。

**验证方式**：`node guard/scripts/smoke-test.js` 里 runPnpm 相关用例通过；`node guard/scripts/guard-cli.js snapshot --profile desktop` 之后不报命令找不到。

### 4.3 node 被解析到错误的一份

**症状**：守护脚本起服时报 node 版本不对、或直接找不到 node。

**原因**：本机可能有多份 node（系统装、DSH 自带、nvm 等），`PATH` 里的不一定是能跑 DSH 的那份。

**解法**：`Resolve-Node()`（`scripts/boot-guard.ps1:83`）三级探测，可用 `DSH_GUARD_NODE` 强制指定；要换守护脚本启动的可执行文件用 `DSH_GUARD_LAUNCH`。

**验证方式**：`node guard/scripts/guard-cli.js status` 正常输出；脚本日志里 `Resolve-Node` 选中的路径就是你期望的那份。

---

## 五、关键路径与配置落点

| 路径 | 内容 |
|---|---|
| `~/.dsh/rollbacks/<profile>/<stamp>/` | 快照目录，五个配置文件 + `manifest.json`（含 sha256 与 `tag`/`reason`） |
| `~/.dsh/guard/config.json` | `keepSnapshots`（默认 10）与可选的 `port` |
| `~/.dsh/guard/logs/` | `boot-*.log`、`server-*.out.log`、`server-*.err.log`、`incident-*.md` |
| `~/.dsh/guard/pending-incident.json` | 待处理事故标记，写完注入 systemPrompt |
| `~/.dsh/guard/quarantine.json` | 被隔离的插件记录 |
| `guard/src/layout.js` | `dshHome()`（认 `DSH_HOME` 否则 `~/.dsh`）、`SNAPSHOT_FILES`、`rollbacksRoot()`、`guardLogsDir()`、`pendingMarkerPath()`、`guardConfigPath()` |
| `guard/src/profile.js` | 全部环境知识：`detectProfile()` / `detectPort()` / `portCandidates()`，常量 `DEFAULT_PORT = 19387`、`LEGACY_WEB_PORT = 3080` |
| `guard/src/engine.js` | 快照、回滚、pnpm 调用、日志清理 |
| `guard/src/incident.js` | 事故报告、健康探测、systemPrompt 注入 |
| `guard/src/tools.js` | 四个工具：`dsh_snapshot`、`dsh_rollback`、`incident_resolved`、以及守卫钩子（`GUARDED_TOOLS = plugin_install / plugin_uninstall / plugin_toggle`，`index.js` 内） |
| `guard/index.js` | 宿主半：`loadSchema()`、`sameOrigin()`、六条 `/guard/api/{state,snapshot,rollback,keep,booted,render-error}` 路由、settings 软探测 |
| `guard/client.js` | 客户端半：`shell.overlay` 心跳、`settings.section` 备份管理、rc.7 的 `settings.plugin.item` 配置卡 |
| `guard/cordis.patch.yml` | `- insert: [{ id: guard, name: 'dsh-maid-guard' }]` |

环境变量：`DSH_GUARD_PROFILE`（强制 profile）、`DSH_GUARD_PORT`（强制健康检查端口，优先级最高）、`DSH_GUARD_PNPM`、`DSH_GUARD_NODE`、`DSH_GUARD_LAUNCH`。

宿主侧硬边界（`index.js`）：`MAX_BODY_BYTES = 1 << 20`（请求体上限 1 MiB）；`sameOrigin()`（:91）无 Origin/Referer 从宽、有则必须同源、`origin === 'null'` 拒绝；写方法必须 `application/json`，否则 **415**；跨站 **403**。

---

## 六、排查手法

**先跑自测，别先怀疑环境。** `node guard/scripts/smoke-test.js`（16 项：快照/回退/解析）与 `node guard/scripts/load-drill.js`（13 项：宿主加载演练，含「`apply()` 在什么都没有和什么都不缺时都不抛」）两条都应在临时 `DSH_HOME` 里跑完并打印 `ALL PASS`，不碰真实快照。它们红了就是代码问题，绿了才轮到看环境。

**三条 CLI 是最快的取证口。** `guard-cli.js profiles` 看有哪些 profile、`list --profile <名>` 看快照、`status` 一起打印健康与待处理事故；`health` 会逐条打印被排除的候选端口——端口误报时先看它。

**401 不等于坏。** 桌面端根路径要 token，`GET /` 回 401 是正常的；`probeHealth` 与 `Test-PortHealth` 都按 2xx–4xx 判活。`Invoke-WebRequest` 遇 401 抛异常，取码要用 `$_.Exception.Response.StatusCode`。

**`node_modules` 出事优先查悬空 link。** link 依赖的插件目录被移走后会留悬空链，`cleanupStaleBundleLinks()` 只删 target 在 `node_modules` 之外的死链，不碰目标、不碰 `.pnpm`。

**事故报告自带定位材料。** `~/.dsh/guard/logs/incident-<ts>.md` 里固定有启动日志 40 行、server stderr 80 行、profiles 与最近良好快照的逐文件 sha256 对比、以及快照清单 6 条；「DSH 版本变化⚠️」段出现时说明这次是宿主升级导致的，配置回滚治不了。

**枚举插件时扫子目录。** 本节包不住在仓根，`find -maxdepth 3 -name package.json -not -path "*/node_modules/*"` 是唯一可靠清单；批量任务收尾必须按它逐项对账。

---

## 附：暂未遇到

- rc.7 上的插件配置卡（`settings.plugin.item` 槽位 + `settingsScope` 服务）本机尚未验证，代码保留软探测分支，待宿主升级到 rc.7 后补实测。
- 跨盘/网络盘上的 `DSH_HOME`：`SNAPSHOT_FILES` 拷贝与 `sha256` 比对在慢速卷上的表现待核。
