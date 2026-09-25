# @cningan/dsh-session-status 规范

这是本包当前的权威规范与代码地图(canonical specification and code map)。它基于已检入的 manifest、Client bundle、Host 入口和文档编写。源码级观察不能替代运行时兼容性或端到端通知验证；未确认的集成行为在下方标注。

## 目的与范围

该 DSH Web Client 插件为每个它观察到处于运行状态的会话发送注意提醒，无论该会话是在前台选中还是在后台。它区分“等待审批/计划审查/提问”与“正常完成/中断/错误/原因暂不可知”的停止。原因数据不足的停止按通用方式报告，绝不推断为成功完成。仅有的初始空闲/等待基线和列表移除不会触发通知；停止边沿恰好落在列表行缺失时也会被抑制，视为可能的移除/归档。全局连接断开不是会话结果；连接状态只用于重连后重新同步。会话状态与恢复仍以 DSH 为准。

本仓库包含一个可直接由 loader 加载的 Client bundle，外加一个空 Host 入口。Profile 的组合/部署与 workbench shell 的实现都属于本仓库之外。

## 包与集成契约

| 契约面 | 已检入契约 |
|---|---|
| 包 | @cningan/dsh-session-status，版本 0.3.1，private ES 模块包 |
| Host 入口 | main 与包根导出都解析到 lib/index.js |
| Client 入口 | ./client 导出解析到 lib/client.js；dsh.client.platform 为 web |
| Client 依赖 | manifest 注入 @deepseek-ai/dsh-client-runtime、@deepseek-ai/dsh-client-connection 与 @deepseek-ai/dsh-client-ui-session；bundle 声明运行时能力槽 slots、sessions、connection 与 uiSession |
| 包脚本 | `test` 使用 Node 内置 test runner 运行 `test/*.test.js`；未声明生成型构建脚本。 |

DSH Profile 通过包名组合该包；其 Profile 配置不在此处维护。本仓库的存在本身不会在任一 Profile 中安装、启用或验证该插件。

## 可观察行为

### 会话事件

- **等待：** bundle 将会话列表行（`sessions.list / byId`）与 `uiSession.sessionStatus` 提供的全会话 Map 快照合并。它只把 `running === true` 视为运行中，并读取每个状态的 `pendingInteraction`。只有插件观察到运行会话之后才产生的等待才有资格触发；初始快照中已存在的等待会被基线化，不报告。`interaction.kind` 将 approval 映射为审批、plan review 映射为计划审查，其他值映射为提问。对象同一性加会话 id 用于对重复快照去重。同一 run 的等待提醒优先于停止提醒。
- **run 停止状态：** 每个会话的 run 状态观察状态映射中的每一条目，而不只是 `uiSession.adapter.current`。只有先前观察到的 `running === true` 变为 `false` 的边沿才能触发；仅列表行消失会被忽略。`completionUnread` 表示有未读输出，不是停止原因或成功标志，也不作为触发条件。只有 `turn/end` 且 `reason.kind === 'completed'` 才归类为正常完成。对于选中会话，观察当前的 `sessions.binding(id).eventSource`，但不调用 `retain` 或 `open`；Host `SessionEventWindow` 定义了含 `SessionEvent` 记录的 `events[]` 和 `target`，但 Client binding 的确切快照形状与生命周期未经独立验证。如果该数据源缺失或形状不同，停止保持通用/未知。明确归因于 `user` 的 `aborted` 原因静默处理。选中会话被显式移除且其 `SessionSnapshot` 详情可用时静默；后台 removed 详情不读取。停止边沿缺失列表行时被抑制，视为可能的移除/归档；`blocked`、`error`、`max-tokens` 与归因到原因的 aborts 有具体消息；`interrupted`、`forked`、legacy 及其他歧义结果保持通用。选中会话的详情错误可提供额外原因。后台会话绝不为获取详情或历史而打开。每个 run 至多通知一次；新的 running 边沿会重置其抑制。
- **连接：** `connection.state` 保持订阅用于恢复同步。非连接状态（包括 connecting）不发出通知，因为传输断开并不能证明任何会话已停止。重连后插件会重新同步会话；它不拥有也不实现恢复。

### 投递与设置

- 等待与停止结果提醒只在对应的 DSH 页面/窗口隐藏或失焦时发送，与当前选中哪个会话无关。设置页自检是有意安排的前台例外，使用固定测试载荷且不改变会话状态。
- workbench 路径先尝试 window.dshShell.notify(payload)；不可用时再尝试 window.chrome.webview.postMessage(payload)。载荷只含 type、kind、title 和 message——不含会话 id，也不会序列化整个会话对象。已检查的 Desktop bundle 未暴露插件可调用的独立闪烁（flash-only）API；其内部 BrowserWindow.flashFrame 调用属于模态 UI。独立闪烁路径需要 DSH 核心/preload 变更，用户已为本任务拒绝。外部桥接的呈现方式（toast/任务栏）与原生点击处理仍未验证。
- 若没有原生桥成功（未暴露任何桥，或所有已暴露的桥都抛错），浏览器路径在浏览器权限已授予时使用 Notification API；静默无操作的桥仍无法检测。原生桥调用只要返回且不抛错就被视为已投递；插件无法识别静默 no-op。浏览器通知以 `silent: false` 请求可听呈现；浏览器/WebView 与操作系统设置仍具权威。点击浏览器通知会尝试通过 `sessions.open(sessionId)` 打开对应会话、聚焦窗口并关闭该通知。
- Settings → General → Session reminders 设置行报告投递能力或浏览器权限状态，可请求浏览器权限，并在投递可用时提供 Send test reminder。它以 id session-notifications、order 30 注册到 settings.general.item；这是能力/设置行，不是会话状态展示。
- 原生桥载荷没有声音字段。外部 shell 是否播放声音或处理点击转到会话的路由，**在本仓库中未知**；不要从浏览器 Notification 路径推断这些行为。

## 所有权与不变量

- DSH 拥有持久会话事实、待处理交互、运行/错误状态、选择语义与连接恢复。本插件只读取官方 Client 表面，不修改 DSH 会话状态。
- 插件持有的状态是临时的：每会话 run/等待边沿去重、选中会话详情/事件观察，以及投递能力/权限快照。它不会仅为通知目的 retain 或打开后台会话。不实现持久设置、localStorage 会话副本或整个会话的序列化。
- Client 使用订阅和页面焦点/可见性监听器，而非轮询循环。订阅、监听器、选中会话详情/事件绑定与注入样式都通过 Client 生命周期 effects 释放。
- 通知声音、权限与操作系统呈现由浏览器/WebView、操作系统以及（原生路径下的）外部 workbench 集成控制。

## 兼容性边界与已知歧义

已检入的 bundle 读取 0.1.7-alpha.1 时代的 uiSession.sessionStatus 与 connection.state 契约，对更早的字段名没有回退。超出这些源码级契约之外的运行时支持**未经验证（UNVERIFIED）**；没有独立的运行时兼容矩阵。见 [docs/compatibility.md](docs/compatibility.md)，其中保留了已记录的迁移/修复历史及其版本差异。

运行中的 Client `SessionSnapshot` 契约没有 `nodes` 字段，因此不得从未文档化的 node 属性推断停止原因。Host `SessionEventWindow` 暴露 `events[]` 与 `target`；选中 binding 的 Client `eventSource` 暂用这些字段解析，因为其确切的窗口形状/生命周期无法重新查询核实。如果该数据源不可用或形状不同，插件会使用显式的 `SessionSnapshot` 错误或通用未知停止提醒。`completionUnread` 既不触发注意提醒，也不证明成功。非选中会话不会被显式打开或 retain 以检查事件历史，因此后台 Stop/Cancel 的归因可能未知并产生通用提醒。

当前 Client 目录（catalog）中没有官方的通知 Service/Event。本包探测可选的 `dshShell.notify` 与 WebView `postMessage` 桥，二者都不是已文档化的插件 Service。对已安装 Desktop bundle 的只读审查发现 `dshDesktop` preload，但没有通知方法，也没有插件可调用的独立闪烁 API；内部 `BrowserWindow.flashFrame` 调用仅限于模态 UI。外部运行时注入与通知呈现仍未验证。独立的闪烁路径需要 DSH 核心/preload 变更，用户已为本任务拒绝。

## 目录与关键文件职责

| 路径 | 职责 |
|---|---|
| package.json | 包标识/版本/exports；DSH Web Client 平台与注入的运行时依赖。 |
| lib/index.js | 空 Host shim：inject = [] 且 apply() {}；行为由 Client 掌握。 |
| lib/client.js | 通过 window.__ModuleLoader__.load 完成 loader 注册，React 经 loader 获取；全会话 run/等待边沿状态、选中会话 SessionSnapshot 与 eventSource 分类、投递能力检测、重连重新同步、shell/浏览器适配器、Settings 槽行、内嵌 CSS 与生命周期清理。这是已检入的 Client bundle，不是本仓库中由源码生成的构建目标。 |
| [README.md](README.md) / [README.zh.md](README.zh.md) | 面向用户的双语（英文/中文）用途说明、启用方式、限制及指向本规范的链接。 |
| CONTEXT.md | 会话提醒术语的共享领域词汇表；不含实现时间线或 API 清单。 |
| docs/compatibility.md | 源码级兼容性观察，以及历史适配/修复与验证记录；不是运行时支持矩阵。 |
| .gitignore | 排除本地依赖、环境文件、日志、缓存、覆盖率与 dist 输出。 |
| .gitattributes | 对 package.json 与 lib/** 关闭 Git 文本规范化。 |

`test/client.test.js` 使用 Node 内置 test runner（`npm test`）覆盖生命周期边沿、事件原因分类、渠道识别、去重、前台抑制与连接断开行为。这些契约级测试不能验证真实 DSH 集成、原生 shell 行为或操作系统实际通知；本仓库没有生成型构建目标。

## 维护规则

当包入口、运行时契约、用户可见行为、所有权不变量或关键路径发生变化时，更新本文件。历史兼容性/修复事实保留在 [docs/compatibility.md](docs/compatibility.md)，不要写入独立的架构地图文档。不支持或未经验证的假设要明确标注。
