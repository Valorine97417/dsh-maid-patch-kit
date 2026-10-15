# dsh-maid-guard

> DSH 小困插件 · 插件守护：装插件前后自动把 profile 存一份档，某次装完起不来了就一键退回上一个能用的状态；装之前先存、崩了之后还能把肇事插件隔离掉，让 DSH 先起来。

本包是 [lxzy-7/dsh-plugin-guard](https://github.com/lxzy-7/dsh-plugin-guard) v0.3.2 的**接管分支**，正本住在 [dsh-maid-patch-kit](../README.md) 的 `guard/`。上游原始文档见 [`README.upstream.md`](README.upstream.md)——它描述的机制（快照语义、隔离原理、回退语义）在这一版里**依然成立**，只是环境假设被换掉了。

## 为什么要接管

**上游停更。** 最后一次提交 `c95036f`（v0.3.2）是 2026-08-18，此后零动静。

**而且原版是照网页版写的，在桌面端装上也是死的。** 三处硬伤：

1. **默认 profile 写死 `'web'`**（`src/index.js:85`、`src/tools.js:183`、`src/incident.js:210/218`、`scripts/guard-cli.js:172`）。桌面端的 profile 叫 `desktop`，回滚接口什么都不指定时永远去翻一个不存在的 profile。
2. **健康检查端口写死 3080**。桌面端的真实端口是 **19387**，而且是运行期由 `dsh-desktop-host` 传进去的，写不进代码。原版会一直报「服务未就绪」。
3. **客户端半边挂在已经删掉的服务上**。`lib/client.js` 的 `exports.inject = ['slots', 'settingsScope']`——`settingsScope` 服务与 `settings.plugin.item` 槽位在 DSH 0.2.0-rc.2 里**已经被整个移除**。`inject` 挂着一个不存在的服务名，整个客户端半边永远 pending：设置页那块「备份管理」不出现，也不报错。

第 3 条是致命的——它连宿主半都进不去，因为 `package.json` 里 `dsh.client.inject` 还声明了 rc.2 根本不存在的 `@deepseek-ai/dsh-client-runtime`。

改动面横跨宿主半、客户端半、CLI 与守护脚本，pnpm patch 装不下；并且**没有新版可跟**，补丁那条路对停更的包本来就是无效的——所以整包搬进来。

## 与原版的差异

**新增 `src/profile.js`——所有环境知识收在这一处。**

- `detectProfile(explicit)` 依次尝试：显式参数 → `DSH_GUARD_PROFILE` → `DSH_PROFILE_DIR` 的目录名 → `profiles/desktop` → `profiles/web` → 排序后第一个 → `'desktop'`。
- `detectPort(configured)`：`DSH_GUARD_PORT` → 配置里的显式值 → `19387`。
- `portCandidates(configured)`：`[DSH_GUARD_PORT?, 配置值, 19387, 3080]` 去重，供健康检查逐个试。

宿主半、CLI、`boot-guard.*` 共用它。**谁也不再写死 profile 名或端口。**

**`src/engine.js`**

- `harnessVersion()` 增加桌面端分支：常规安装路径读不到时，从 `process.argv` 里找那个含 `node_modules/@deepseek-ai/dsh-desktop-host` 的目录参数，读它的 `package.json`。
- **去掉唯一的运行时依赖 `js-yaml`**，换成内置的行解析器 `parsePatchEntries()` + `yamlScalar()`（够解析 `cordis.patch.yml` 的 `- id:` / `name:` / `insert:` 三项，含行尾注释剥离）。原因：桌面端 profile 的 `node_modules/@deepseek-ai` 是**空目录**、裸名只有 `schemastery`，第三方依赖不保证解析得到。现在本包**零外部依赖**，任何 pnpm 布局都能加载。
- `readGuardConfig()` 的默认 port 从 `3080` 改为 `null`（`null` = 交给探测器），`writeGuardConfig()` 只在 port 有效时才落盘该字段。

**`src/incident.js`**

- 报告里两处硬编码的 `'web'` 改用 `detectProfile()`。
- 新增 `probeHealth(port)`：不给端口就按候选逐个试，返回 `{ port, healthy, tried }`。判据仍是 `2xx–4xx` 算健康——**401 也算活**，因为桌面端根路径要求鉴权 token，`GET /` 返回 401。

**`index.js`**

- 顶层 `import z from '@deepseek-ai/schemastery'` 改**动态可选加载**（先试 `@deepseek-ai/schemastery`、再试裸名 `schemastery`，都失败就跳过设置注册）。静态 import 在桌面端会让**整个插件**加载失败。
- `handleRollback` 的默认 profile 改用 `detectProfile()`。
- `settings` 段改成软探测：`typeof settings.register === 'function'` 不成立就安静返回。rc.2 的 `SettingsForms` 只暴露 `configure/describe/update/...`，**没有 `register()`**，原版的调用必然抛错（被 `try/catch` 吞掉，桌面端从来没出现过配置卡）。

**`client.js`**

- `exports.inject` 从 `['slots', 'settingsScope']` 收窄到 `['slots']`。
- 插件配置卡那段改成 `ctx.get('settingsScope')` 软探测：有才挂，没有就不挂。
- 保留 `settings.section`（设置页「备份管理」）与 `shell.overlay`（启动心跳）——这两条槽位 rc.2 都还在。
- 文案里的 web 语境换成桌面端。

**`scripts/`**

- `boot-guard.ps1`：启动形态改为「根目录有 `DeepSeek Harness.exe` 就起桌面壳（无参数），没有才退回 `cmd.exe /d /s /c "<root>\node_modules\.bin\dsh.cmd" web`」；`$Port = 0` / `$Profile = ""` 表示自动探测；新增 `Test-PortHealth()`（**401 判活**——`Invoke-WebRequest` 遇 401 会抛异常，从 `$_.Exception.Response.StatusCode` 读码）；`Resolve-Node()` 三级探测 node。
- `boot-guard.sh` / `rollback.cmd` / `guard-cli.js`：默认 profile 与端口一并跟探测器走。
- `guard-cli.js` 的 `health` / `status` 用 `probeHealth()`，逐条打印被排除的候选端口。
- `load-drill.js`（自测）：拿假 ctx 调 `apply()`，确认它在「什么都拿不到」和「服务齐全」两种情况下都不抛——真插件最致命的失效方式不是功能坏掉，而是 apply() 抛错把整个 profile 拖下水。同时用临时 DSH_HOME 验证 pre-tool 钩子**真留下了 `auto-before-install` 快照**，并单独构造一个坏掉的 profiles 目录，确认存档失败时钩子仍然静默（安全网不能反过来堵死安装）。

## 安装

```bash
node guard/scripts/guard-cli.js profiles                     # 看有哪些 profile
node guard/scripts/guard-cli.js snapshot --profile desktop    # 存一份档
node guard/scripts/guard-cli.js list --profile desktop        # 列快照
node guard/scripts/guard-cli.js health                        # 多端口探活
node guard/scripts/guard-cli.js status                        # 健康 + 待处理事故
node guard/scripts/guard-cli.js quarantine --list             # 看被隔离的插件
node guard/scripts/smoke-test.js                              # 快照/回退/解析 16 项自测，末行应打印 ALL PASS
node guard/scripts/load-drill.js                              # 宿主加载演练，13 项，末行应打印 ALL PASS
```

接入桌面端 profile：`package.json` 的 `dependencies` 加 `"dsh-maid-guard": "link:<本仓>/guard"`，`dsh.profile.bundles` 加 `"dsh-maid-guard"`，然后 `pnpm install`。重装或删除走反向操作。

## 数据落点

| 路径 | 内容 |
|---|---|
| `~/.dsh/rollbacks/<profile>/<stamp>/` | 快照目录，含五个文件 + `manifest.json` |
| `~/.dsh/guard/config.json` | `keepSnapshots`（保留份数，默认 10）与可选的 `port` |
| `~/.dsh/guard/logs/` | `boot-*.log`、`server-*.out.log`、`server-*.err.log`、`incident-*.md` |
| `~/.dsh/guard/pending-incident.json` | 待处理事故标记，写完会注入 systemPrompt |
| `~/.dsh/guard/quarantine.json` | 被隔离的插件记录 |

快照含 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、`cordis.yml`、`cordis.patch.yml` **五个文件**（`cordis.yml` 在列是因为 MCP 配置在里面）。装插件（`plugin_install` / `plugin_uninstall` / `plugin_toggle`）前会自动先存一份 `auto-before-install`。

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_GUARD_PROFILE` | 强制默认 profile |
| `DSH_GUARD_PORT` | 强制健康检查端口（优先级最高） |
| `DSH_GUARD_PNPM` | 指定 pnpm 可执行文件 |
| `DSH_GUARD_NODE` | 指定 node 可执行文件 |
| `DSH_GUARD_LAUNCH` | 指定守护脚本要启动的可执行文件 |

## 边界

- **不改上游仓库**。本目录是接管后的独立正本，上游哪天复活了，比对 `README.upstream.md` 描述的机制差异再决定是否合并回去。
- **rc.2 上插件配置卡不存在**。`keepSnapshots` 在 rc.2 只能通过设置页「备份管理」里的输入框或 `guard-cli.js keep` 改；`settingsScope` 那条路留着给将来版本。
- `smoke-test.js` 与 `load-drill.js` 都在临时目录里造 DSH_HOME 跑，不碰真实快照。
- 本包只面向本机 desktop profile，不试图做成通用工具。

## License

MIT（继承上游）
