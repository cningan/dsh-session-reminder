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
- **投递与前台规则**：等待/停止提醒只在对应页面/窗口隐藏或失焦时发送，与当前选中哪个会话无关；设置页自检是有意的前台例外，发送固定测试载荷、不改变会话状态。桥尝试顺序 `window.dshShell.notify` → `window.chrome.webview.postMessage`；载荷只含 type/kind/title/message，不含会话 id、不序列化整个会话。浏览器路径在权限已授予时用 Notification API，`silent: false` 请求平台声音；已暴露但静默无操作的桥无法检测。独立闪烁（flash-only）需要 DSH 核心/preload 变更，用户已拒绝，不做。
- **状态与所有权**：DSH 拥有持久会话事实、待处理交互、运行/错误状态、选择语义与连接恢复；插件只持有临时状态（每会话边沿去重、选中会话观察、投递能力/权限快照）。订阅/监听器经 Client 生命周期 effects 释放，不建轮询。
- **设置项**：在**插件配置页**的 `settings.section` 注册 section（id `@cningan/dsh-session-status`、order 30、label 走 locale），内容区报告投递能力或浏览器权限状态，可请求权限，提供 Send test reminder。不是常规设置页的 `settings.general.item` 行。
- **语言**：文案字典经官方 `locale` 服务注册（`ctx.locale.register` / `ctx.locale.bind`），语言跟随 DSH 界面设置；不读 `document.documentElement.lang` 或 `navigator.language` 猜测语言，也不在插件启动时把语言定死。
- **可安装性**：包声明 `dsh.bundle.patch`（`./cordis.patch.yml`）并自带该 patch，官方安装渠道才能把它识别为 bundle；安装输入用本地 `.tgz`（内容解包进 profile），不用目录/`link:` 形式（只建 junction 会让 `@deepseek-ai/*` 解析失败）。
- **诊断与可审计性**：Host 半边注入 `webServer` 并注册 `/plugins/dsh-session-status/diagnostics`，把 Client 上报的装载快照、数据源形状（列表是否有 `byId`、`sessionStatus` 是否覆盖当前会话）、运行/等待边沿、前台判定与投递结果追加写入 profile 下 `.dsh-session-status/diagnostics.jsonl`；Host 加载时先写一条 `host-ready`，用来区分"Host 未运行"与"Client 未上报"。上报失败不影响提醒行为。`npm run diagnose`（`scripts/check-diagnostics.mjs`）读取该文件给出结论与退出码（0 已投递 / 1 链路断开 / 2 无数据 / 3 尚未观察到停止边沿）。

## 测试决策

- **测试约定**：用 Node 内置 test runner（`npm test`），覆盖生命周期边沿、事件原因分类、渠道识别、去重、前台抑制、连接断开处理、设置区注册位置（`settings.section`）、语言跟随官方 locale 字典，以及诊断契约（Host 路由的写入与拒绝分支、Client 上报内容与前台抑制上报）；这些是契约级测试，不替代真实 DSH 集成、原生 shell 行为或操作系统通知验证。
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
