# dsh-session-status 规格

遵循统一规格模板（问题陈述 / 方案 / 用户故事 / 实现决策 / 测试决策 / 范围外 / 备注）。源码与测试是行为事实；运行时兼容性与端到端通知验证不能由源码级观察替代，未确认的集成行为在下方标注。使用与自检方法见 [README.md](README.md)（中英双语），兼容性史见 [docs/compatibility.md](docs/compatibility.md)。

## 问题陈述

DSH Web 用户会同时跑多个会话：当窗口失焦或隐藏时，一个会话在等待审批/计划审查/回答，或已经结束（正常/中断/失败/原因未知），用户得不到提醒，直到返回页面才发现。已有的完成未读标记既不能证明成功，也不能区分"等待"与"停止"；连接断开又常被误当成会话停止。需要一个只读、不越权（不打开/不 retain 其它会话）的通知插件。

## 方案

`@cningan/dsh-session-status` 是一个 DSH Web Client 插件：对**每个已观察到正在运行**的会话，在其停止边沿（观察到 `running: true → false`）或等待交互发生时，于对应 DSH 页面/窗口隐藏或失焦时发出注意提醒。它只消费官方 Client 表面（全会话状态快照、选中绑定的 SessionSnapshot/eventSource、连接状态），不持久化会话状态，也不打开其它会话。提醒经 workbench 桥（`window.dshShell.notify` → `window.chrome.webview.postMessage`）投递，桥不可用或抛错时回退到浏览器 Notification API。

## 用户故事

1. 作为 DSH 用户，我想在窗口失焦时收到"等待审批/计划审查/提问"的提醒，以便及时回来处理。
2. 作为 DSH 用户，我想在运行会话真正结束时收到停止提醒（区分正常完成/中断/错误/原因未知），以便不被误判。
3. 作为 DSH 用户，我想让原因数据不足的停止按"通用停止"报告，以便不会被谎报成成功完成。
4. 作为 DSH 用户，我想让明确由我取消的会话保持静默，以便不被打扰。
5. 作为 DSH 用户，我想让被显式移除的会话（详情可得时）静默，以便不收到归档/移除误报。
6. 作为 DSH 用户，我想点浏览器通知后打开对应会话并聚焦窗口，以便直接继续。
7. 作为维护者，我想让连接断开本身不触发提醒（只用于重连后重新同步），以便传输层问题不被当成会话结果。
8. 作为维护者，我想让插件只读官方表面、不为通知保留或打开其它会话，以便不动 DSH 的会话事实与恢复。
9. 作为维护者，我想让同一 run 每一种通知至多一次，以便不重复打扰。
10. 作为用户/维护者，我想用设置页自检发固定测试载荷验证投递通道，以便不改会话状态就能确认通道可用。
11. 作为中文用户，我想让提醒文案与设置区始终跟随 DSH 界面语言，以便不出现中英混排或语言漂移。
12. 作为维护者，我想让设置入口位于插件配置页（而不是常规设置页），以便插件配置与常规设置分区明确。
13. 作为维护者，我想让插件把每次边沿、前台判定与投递结果落盘，以便事后审计而不必盯着窗口等会话结束。

## 实现决策

- **会话事件判定**：把官方会话列表行与全会话状态快照合并；只有 `running === true` 才算运行中。等待只对插件观察到运行会话**之后**出现的交互计为中奖，初始快照中的等待被基线化不报告；`interaction.kind` 映射 approval→审批、plan review→计划审查、其余→提问；对象同一性加会话 id 去重；同一 run 的等待提醒优先于停止提醒。
- **停止判定**：观察全会话状态映射（不仅当前会话）。只有先前观察到 `running === true` 变为 false 的边沿才触发；仅列表行消失被忽略。`completionUnread` 既不触发提醒，也不证明成功。仅 `turn/end` 且 `reason.kind === 'completed'` 归类为正常完成；`blocked`、`error`、`max-tokens` 及归因到原因的 aborts 有具体消息；`interrupted`、`forked`、legacy 与歧义结果保持通用。`aborted` 且明确归因于 `user` 的静默；被显式移除的选中会话（详情可得）静默；停止边沿缺失列表行时抑制（视为可能的移除/归档）。每 run 至多通知一次，新的 running 边沿重置抑制。
- **事件源使用**：对选中会话观察 `eventSource`（Host `SessionEventWindow` 的 `events[]`/eventSource 字段），但不调用 `retain` 或 `open`；数据源缺失或形状不同时停止保持通用/未知。后台会话绝不为获取详情或历史而打开。
- **连接处理**：订阅 `connection.state` 仅用于重连后重新同步；非连接状态（含 connecting）不发通知。
- **投递与前台规则**：等待/停止提醒只在对应页面/窗口隐藏或失焦时发送，与当前选中哪个会话无关；设置页自检是有意的前台例外，发送固定测试载荷、不改变会话状态。桥尝试顺序 `window.dshShell.notify` → `window.chrome.webview.postMessage`；载荷只含 type/kind/title/message，不含会话 id、不序列化整个会话。浏览器路径在权限已授予时用 Notification API，`silent: false` 请求平台声音，通知 tag 逐条唯一，且**绝不设置 `requireInteraction`**（[ADR-0001](docs/adr/0001-no-require-interaction-short-unique-tags.md)）——桌面 WebView 下 `requireInteraction: true` 的通知会被平台静默丢弃（构造成功、既不显示也不触发任何事件，2026-09-26 由 A/B 探针实测确认），代价是提醒按系统默认超时自动消失；已暴露但静默无操作的桥无法检测。独立闪烁（flash-only）需要 DSH 核心/preload 变更，用户已拒绝，不做。
- **状态与所有权**：DSH 拥有持久会话事实、待处理交互、运行/错误状态、选择语义与连接恢复；插件只持有临时状态（每会话边沿去重、选中会话观察、投递能力/权限快照）。订阅/监听器经 Client 生命周期 effects 释放，不建轮询。
- **设置项**：在**插件配置页**的 `settings.section` 注册 section（id `@cningan/dsh-session-status`、order 30、label 走 locale），内容区报告投递能力或浏览器权限状态，可请求权限，提供 Send test reminder。不是常规设置页的 `settings.general.item` 行。
- **语言**：文案字典经官方 `locale` 服务注册（`ctx.locale.register` / `ctx.locale.bind`），语言跟随 DSH 界面设置；不读 `document.documentElement.lang` 或 `navigator.language` 猜测语言，也不在插件启动时把语言定死。
- **可安装性**：包声明 `dsh.bundle.patch`（`./cordis.patch.yml`）并自带该 patch，官方安装渠道才能把它识别为 bundle；安装输入用本地 `.tgz`（内容解包进 profile），不用目录/`link:` 形式（只建 junction 会让 `@deepseek-ai/*` 解析失败）。
- **判定核心的深化（进行中）**：判定分成三块纯 module——`core/classify`（上游原因 → 语义）、`core/text`（语义 → 文案）、`core/decide`（领域快照 → 这一轮该产出哪些提醒）。`core/decide` 的接口是 `observe(snapshot) → notices`：判定状态（上一轮快照、每会话 run 序号、等待/停止是否已提醒）由它自己持有，调用者只按时间顺序喂**归一化后的领域快照**（`sessions[{ id, title, running, pending, unread, inList }]`、`currentId`、`current: { removed, turnEnd, detail }`，`current` 可为 undefined）；输出是语义枚举 `notice = { sessionId, title, kind: pending|terminal, reason, detail }`，不含文案，也**不含前台判定**——产出提醒与投递提醒是两件事，前台抑制属于投递层。快照的 `pending` 必须是同一个等待请求在多次快照之间复用的同一对象（等待边沿按对象同一性判断）；`current.turnEnd` 是 `turn/end` 的原始原因对象、`current.detail` 是已抽取字段的领域形状，分别直接交给 `classifyTurnEnd` / `classifyDetail`；`unread` 只是忠实反映上游未读标记，判定不用它。**追加**的只读边沿事实通道：判定核心是唯一知道「边沿」的地方，所以它另外暴露一份只读事实（`edges`），覆盖「本轮产出了提醒」与「观察到边沿但没有提醒」（列表行不在而被抑制、用户取消或选中会话已显式移除而静默）两类；每条事实带 `noticeIndex`（指向本轮 `notices` 里的那一条，`null` 表示没有提醒）、等待边沿的上游交互子类，以及停止边沿的抑制原因/是否选中会话/有无 `turn/end` 原因，顺序是「已提醒的在前（与 notices 同序）、仅观察到的在后」。`observe` 的 notices 契约**不变**——边沿事实不挂在那份返回值上（附加属性会改变调用方对返回值的相等性判断），而是走独立的只读出口；装配层（`client/assembly`）因此不再自己记账 run 边沿、也不再补写边沿记录。装配层保留归一化、`currentId` 绑定、当前会话事件窗口缓存（上一轮 run 的原因/详情不能留给下一轮；它用的每会话 running 记账只为这份缓存定界，与诊断无关）、投递与诊断。设置区与调试能力的分离见下一条。迁移分九步、每步保持测试绿；未采纳的候选见 issue #1–#4。
- **装配收口**：官方源的读取与归一化（`sessions.list` / `uiSession.sessionStatus` / `uiSession.adapter.current` / `connection.state` → 领域快照）、订阅与生命周期释放、前台否决、投递键记账、内存诊断、调试连接口与 slot 注册全部收敛在 `client/assembly`；它是 Client 半边**唯一**读官方源的模块（判定核心、投递层、设置区、诊断上报层都不读）。`lib/client/source.mjs` 不再存在（文件名不再撒谎），loader 入口直接指向装配；装配导出真正的 ESM 插件表面（`apply` + `inject`），不留没有消费者的 CommonJS 拟态形状。**Client 依赖清单单一来源**：装配层的一张依赖表同时声明本地服务名与提供它的官方包名，`inject`（本地服务名，运行时注入用）与 `package.json` 的 `dsh.client.inject`（官方包名，按 Harness 语义只用于排序激活）都由它派生，直测断言两处名单逐项一致——任一处单方面增删都会失败，名单不再各自漂移。
- **投递层的分离（进行中）**：渠道选择集中在 `client/delivery`——按 `window.dshShell.notify` → `window.chrome.webview.postMessage` → 浏览器 `Notification` 的顺序尝试；平台事件（`onshow`/`onerror`/`onclose`）、通知 tag 与权限读取（含请求）也都在这里。它的接口**不含判定语义**：调用者交来一条已经决定要投的提醒（`{ key, kind, sessionId?, title, message }`）与自己记录的事实（`background`），拿回结构化结果——`outcome` 显式区分「已交给原生桥 / 已交给浏览器 API / 无可用渠道 / 浏览器 API 抛错」，`fellBack` 单独表示「渠道抛错后回退」，不必靠 channel 字符串猜。前台否决与投递去重记账（`deliveredKeys`）留在装配层：前台抑制时装配层自己记账并上报一条 `channel: suppressed-foreground` 的投递记录，投递层不参与这类决定。诊断上报经注入的 `report(event, payload)` sink 完成（缺省 no-op，投递照常且绝不因上报失败而中断）——那就是诊断上报层的 sink，投递层只从它的常量表取事件名，不散写字面量；`tag` 逐条唯一且短（`dshss-N`）、绝不设置 `requireInteraction`（[ADR-0001](docs/adr/0001-no-require-interaction-short-unique-tags.md)）。渠道抛错只影响回退与「能力/权限如何报告」，不改变投递顺序：每次投递都重新按顺序尝试。
- **设置区与调试能力的分离（进行中）**：设置区（React 组件、CSS、设置行状态机、locale 绑定接线）独立成 `client/settings`，只吃注入进来的协作者 `{ model, t, debugTools }`，不再读装配层的私有变量、也不自己去取 React。调试能力（诊断文本块、探针、测试模式开关）独立成 `client/debug-tools`，由装配层**只在 `__DEBUG__` 为真时构造**并注入设置区，不再挂在 model 上；因此 **model 暴露的键在正式与调试构建里完全一致**（`getSnapshot` / `subscribe` / `requestPermission` / `sendTestNotification`），修掉「一个是否存在取决于编译期常量的表面不是 interface」这条走查意见（issue #4）。两侧互相需要的地方由装配层建的**调试连接口**显式打通：model 填「按前台规则投递一条临时提醒」与「触发一次重渲染」两个出口，debugTools 拥有测试模式开关的真值；探针因此与自动提醒共用同一个投递实例（tag 序号、桥状态、权限）与同一份内存诊断，键的序号也与设置页自检共用同一个计数器——调试构建下的诊断记录逐字节不变。正式构建里这个口连同 debugTools 一起是 null，model 只是没有注入方。`getSnapshot()` 的 `testMode` 在两种构建里都存在（正式构建恒为 false）：它报告的是「前台抑制当前是否被覆盖」这一位策略，不是调试 API。设置区的元素树形状在两种构建里一致——没有注入方时那两个位置就是空位，调试 UI 不是「隐藏」，而是根本没渲染。
- **构建与调试分离**：`lib/client.js` 是构建产物（esbuild 打包 `lib/client/`）。正式构建不含诊断面板、探针与测试模式 API——它们连 model 的键都不影响（调试能力是注入的 `client/debug-tools`，正式构建里不构造）；调试构建（`build:client:debug`）保留它们。`npm test` 经 `pretest` 针对调试构建运行，`npm run check:production` 断言正式产物无调试残留，`prepack` 走正式构建。见 [ADR-0002](docs/adr/0002-debug-capability-only-in-debug-build.md)。
- **诊断与可审计性**：Host 半边注入 `webServer` 并注册 `/plugins/dsh-session-status/diagnostics`，把 Client 上报的装载快照、数据源形状（列表是否有 `byId`、`sessionStatus` 是否覆盖当前会话）、运行/等待边沿、前台判定与投递结果追加写入 profile 下 `.dsh-session-status/diagnostics.jsonl`；Host 加载时先写一条 `host-ready`，用来区分"Host 未运行"与"Client 未上报"。Client 侧的上报统一走**诊断上报层**（`client/diagnostics-sink`）：事件名收敛成一张常量表（attach / status / edge / deliver / platform / source-shape），**落盘记录形状（字段与顺序）**集中在那里，路由按插件包名推导（`/plugins/<包名>/diagnostics`，可显式覆盖），`fetch` 与时钟可注入（测试用替身）。上报失败**绝不抛**、绝不影响提醒行为。停止边沿的记录由判定核心的只读边沿事实转成：被抑制（列表行不在）与静默（用户取消、已显式移除）的停止边沿没有提醒可投，但仍有同形记录，读方据此区分「边沿被抑制」与「还没观察到边沿」。**JSONL 的记录形状与事件名不得改变**——读方与它的固定样本测试依赖它（字段与取值逐字节一致）。`npm run diagnose`（`scripts/check-diagnostics.mjs`）读取该文件给出结论与退出码；**结论词与退出码语义的唯一定义是该脚本头部的 `VERDICTS` 表**，本规格与 README 只引用、不复制，避免多处漂移。读方区分「投递调用成功」（`delivered: true`，即 `new Notification()` 没抛错）与「平台确认显示」（同一 key 的 `onshow`/`onclose`）：只有后者才是 [ADR-0001](docs/adr/0001-no-require-interaction-short-unique-tags.md) 所需的强证据；`delivered: true` 但该 key 零平台反馈时给出"未确认"结论而不是成功，`onerror` 则给出带 error 文本的平台拒绝结论。

## 测试决策

- **判定族直测**：判定逻辑（停止/运行边沿、原因分类、去重、抑制、等待优先于停止、tag 唯一性）以 **Node 直测**覆盖——喂领域快照序列，不模拟浏览器（不 `import vm`、不用 `document`/`window`）；判定核心的直测与装配接线解耦。装配层的 `vm` 集成测试只保留 5 条**端到端链路**（订阅 → 判定 → 文案 → 投递 → 上报：后台停止边沿、选中会话的原因来源、前台否决的记账、渠道回退、locale 与 `settings.section` 注册），且只断言**装配层独有、别处观察不到**的事实——官方源的读取与归一化（含官方快照的字段名）、`turn/end` 事件窗口缓存与「新一轮丢弃上一轮原因」的定界、语义到通知标题/正文的组装、前台否决的记账与上报、调试连接口（探针与自动提醒共用投递出口）、`settings.section` 的注册元数据；逐条重建假浏览器的判定断言不再在本层重复（每条被删断言都能映射到上述直测）。
- **投递层直测**：渠道选择与平台事件（`client/delivery`）也以 Node 直测覆盖——只注入最小替身（桥、Notification 构造器、sink），不模拟整个浏览器：桥逐级回退、无可用渠道（权限未授予 / 无 API）与「抛错后回退」可区分、平台事件回灌 sink、点击通知打开会话、tag 短且唯一、请求体不含 `requireInteraction`、sink 缺失或抛错时投递照常。
- **诊断上报层直测**：诊断上报层（`client/diagnostics-sink`）以 Node 直测覆盖——只注入假 `fetch` 与假时钟，不模拟浏览器：事件名常量表是六类事件的单一来源、六类事件各自的落盘形状逐字节（含字段顺序）与读方解析的形状一致、路由由包名推导且可覆盖、缺 `fetch`／`fetch` 抛错／返回非 Promise／拒绝／时钟抛错时绝不抛，以及边沿记录通道（判定核心的只读边沿事实 → 与既有 JSONL 同形的记录，含抑制/静默那一类；该记录喂给读方得到「停止边沿被抑制」而不是「还没观察到边沿」）。判定核心的只读边沿事实另在判定族直测里覆盖：notices 契约不变、顺序（已提醒的在前）、静默与抑制可区分、冻结只读。
- **测试约定**：用 Node 内置 test runner（`npm test`），覆盖生命周期边沿、事件原因分类、渠道识别、去重、前台抑制、连接断开处理、设置区注册位置（`settings.section`）、语言跟随官方 locale 字典，以及诊断契约（Host 路由的写入与拒绝分支、Client 上报内容与前台抑制上报）；这些是契约级测试，不替代真实 DSH 集成、原生 shell 行为或操作系统通知验证。
- **设置区与调试工具直测**：设置区（`client/settings`）与调试工具（`client/debug-tools`）也以 Node 直测覆盖——只注入替身（假 React 三件套、假 `model`、假 locale、假连接口、假定时器），不模拟浏览器：探针经注入的连接口投递且载荷与自检同源（键前缀 + kind + 文案）、连发与延迟只经注入的定时器、测试模式开关写在连接口上并触发一次重渲染、诊断文本块四行在缺数据时给占位；设置区在**没有注入方**时元素树里就是两个空位（不渲染诊断块与工具行），注入调试工具时诊断块与四个按钮都在且点击探针可达，另有设置行状态机（自检提示、请求权限忙碌态复位）与 locale 绑定接线、样式表安装/卸载。
- **model 表面一致性直测**：同一份源码在内存里各打一次**正式**与**调试** bundle（esbuild `write: false`，不动仓库产物），装进同一套最小假浏览器断言 `Object.keys(model)` 两种构建完全相同、且与调试键（`sendProbe` / `sendProbeBurst` / `sendDelayedProbe` / `setTestMode`）无交集；正式构建不构造调试工具（设置区拿到 null），调试构建构造它并经设置区注入，探针的键与自检共用同一个计数器，注入的测试模式开关仍能覆盖前台否决；正式产物不含调试特征、调试产物含（阳性对照，防止断言退化成永真）。
- **诊断读方直测**：读方（`scripts/check-diagnostics.mjs`）以固定样本 JSONL 直测——「平台确认显示」「平台 onerror」「仅投递调用成功、无平台事件」三种输入各断言结论词与退出码；判定面是纯函数 `analyze(records)`，CLI 只在被直接执行时运行。
- **装配层契约直测**：装配层（`client/assembly`）以 Node 直测覆盖两条契约——Client 依赖清单单一来源（`inject` 与 `package.json` 的 `dsh.client.inject` 必须由同一张依赖表派生、两处名单逐项一致），以及 loader 契约（同一份源码在内存里各打一次正式与调试 bundle，装进最小假浏览器经 `window.__ModuleLoader__.load` 跑一遍 factory，断言拿到的是真插件表面 `apply` + `inject`，没有 CommonJS 拟态残留）。
- **运行态验证**：有效的自动通知端到端测试必须用全新、普通的 DSH 用户会话，并在 DSH 页面/窗口隐藏或失焦时结束；构建会话、子 Agent、单元测试与前台设置自检都不满足该测试。在真实会话停止的用户可见自动通知得到确认之前，不声称 E2E 成功、不推送 GitHub。

## 范围外

- 修改 DSH 核心/preload 实现任务栏闪烁；修改 Profile 挂载配置；调用 `cordis_inspect_query` 的 Client Inspect。
- 会话状态持久化、整个会话对象的序列化、持久设置与 localStorage 会话副本。
- 通知声音、权限与操作系统呈现的控制（由浏览器/WebView、操作系统及外部 workbench 集成决定）。
- workbench shell 实现（外部集成边界，不含在本仓库）。

## 备注

- 兼容性：bundle 消费 0.1.7-alpha.1 时代的 `uiSession.sessionStatus` / `connection.state` 契约，无更早字段名回退；运行时兼容性未验证（UNVERIFIED），没有独立运行时兼容矩阵；历史适配/修复与版本差异见 docs/compatibility.md。
- 运行中的 Client `SessionSnapshot` 契约没有 `nodes` 字段，不得从未文档化属性推断停止原因。
- 原生桥载荷无声音字段；外部 shell 是否播放声音或做点击路由在本仓库未知，不要从浏览器路径推断。
- 安装契约：只走官方渠道（`plugin_manager` / 客户端「添加插件」），本地插件用压缩包投放，先本地测试通过再考虑远端；详见 AGENTS.md 的安装规约与 `dsh-profiles/docs/install-specs.md`。
- 当包入口、运行时契约、用户可见行为、所有权不变量或关键路径变化时，更新本文件；历史兼容性事实保留在 docs/compatibility.md，不写入独立架构地图文档。
