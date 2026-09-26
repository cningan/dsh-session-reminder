# DSH Client 兼容性说明

本说明只概括 2026-09-22 适配说明（§II）中为 DSH 0.1.7-alpha.1 记录的两处契约变更，然后将当前一侧与本包源码对照检查。这是源码级说明，不是运行时支持矩阵。

| 契约面 | 适配说明中记录的历史变更 | 本仓库验证的当前 bundle |
|---|---|---|
| 等待交互 | 从按 requestKey 索引的 uiSession.pendingInteractions 改为 uiSession.sessionStatus——按会话存储的 Map，包含 running、pendingInteraction 与 completionUnread。说明称 pendingInteraction 仍带有 kind。 | readSessionStatus 接受全会话 Map；syncSessions 遍历每一条目，读取 running 与 pendingInteraction，并用 interaction.kind 生成标签。初始等待被基线化；后续等待按对象同一性与会话 id 去重。见 [状态快照](../lib/client.js#L603-L613)、[等待处理](../lib/client.js#L664-L679) 与 [kind 映射](../lib/client.js#L212-L216)。 |
| 连接状态 | 从 connection.hostDescription 改为 connection.state，取值为 connected、connecting 与 disconnected。 | observeConnection 仍订阅 ctx.connection.state，只把 connected 视为可用；但非连接状态不再是通知原因。重连只重新同步会话状态。见 [连接处理](../lib/client.js#L704-L737)。 |
| 停止原因 | Host 的 `session/event` 在提交后发出含 `seq`、`type`、`data` 的 `SessionEvent`；Host `SessionEventWindow` 有 `events[]` 和 `target`。Client 会话 binding 的 `eventSource` 按既有 Client 契约可知，但其确切窗口形状与生命周期未重新查询。 | 插件只观察选中 binding，从不显式调用 `retain` 或 `open`，并按 Host 窗口形状暂作解析。只有 `turn/end` 且 `reason.kind === 'completed'` 才证明成功；仅凭 `completionUnread` 既不触发提醒，也不能归类其原因。显式“用户中止”的结果静默处理。`removed` 详情只对选中会话查用；后台 removal/Stop/Cancel 的原因可能未知并产生通用提醒。无列表行的停止边沿会被抑制，视为可能的归档/移除。歧义的 interrupted/forked/legacy 或数据源不可用等结果保持通用。后台会话不会为事件历史被打开。见 [turn/end 分类器](../lib/client.js#L271-L293)、[eventSource 绑定](../lib/client.js#L482-L588) 与 [停止处理](../lib/client.js#L456-L479)。 |

## 待处理交互去重

适配说明记录：旧的 request key 已消失，且同一次等待的 pendingInteraction 对象在多个快照中是同一个对象实例。当前 bundle 用 WeakMap 和递增序列为对象分配同一性，再把该同一性与会话 id 组合成去重键；它读取 kind 作为通知标签。见 [同一性分配](../lib/client.js#L591-L597)、[去重键](../lib/client.js#L220-L222) 与 [等待通知](../lib/client.js#L670-L679)。静态源码能确认实现本身，但不能确认上游的生命周期保证。

## 兼容性边界

当前 bundle 使用上述新一侧字段，且没有对历史字段名的回退。适配说明是历史一侧的事实来源；当前 bundle 只验证新一侧的读取。本说明不声称与更早的 DSH 版本运行时兼容。

适配说明称 connecting 不是 disconnected 状态。当前包仍只把 connected 视为可用，但非连接值只标记传输断开以供之后重新同步；它们从不产生会话通知。这是不同的层：仅凭 API 状态标签并不能定义本包的通知策略。

## 历史修复：DSH 0.1.5 等待通知

2026-09-14 的维护记录显示：插件从会话列表行读取 `pendingInteraction` 后等待通知失效，因为该字段在 DSH 0.1.5 契约中已不存在。记录的替代方案是 `ctx.uiSession.pendingInteractions`——一个承载 `key`、`kind`、`sessionId` 的待处理对象可观察 map。这里描述的是那次历史修复，不是当前的挂钩行为。

当前子仓库源码使用后来的 `uiSession.sessionStatus` map，读取每个状态的 `pendingInteraction`；它订阅 `uiSession.sessionStatus`，不包含对 `uiSession.pendingInteractions` 的运行时读取。见 [当前状态读取](../lib/client.js#L603-L613)、[当前等待处理](../lib/client.js#L664-L691) 与 [订阅](../lib/client.js#L778-L783)。当前 manifest 版本为 `0.3.1`（[package.json](../package.json#L4)）。

**版本记录：** 历史报告写的是 `0.3.1 → 0.4.0`；当前 manifest 写的是 `0.3.1`。两个值不同。本说明按原样保留两者，不推断发布或版本时间线。

**验证记录：** 历史报告记录了语法检查与 `plugin_check` 通过。它还明确说明等待通知未在真实设备上测试；用户判断逻辑足够并视为通过。那是用户的验收判断，不是实际观察到的通知测试。这些是历史结果，不是对当前子仓库检出内容的验证。

## 仓库源码快照验证（历史记录；日期未记录）

此前的建仓记录：仓库初始化期间对 `lib/index.js` 与 `lib/client.js` 运行过 Node JavaScript 语法检查。它还记录了未执行 `plugin_check`、Profile 重启或真实通知端到端测试。这是历史建仓报告，不是对当前检出内容的验证。

## 历史停止详情回退说明（已被取代）

较早的一条说明称：当前会话详情对象缺失可能使停止状态边沿报告占位的 interruption 原因。当时检查的源码在其状态边沿回退中提供 `{ running: false }`，并把缺失错误详情当作正常完成。该行为此后已被取代：当前源码使用 Host 的 `SessionEventWindow` 字段暂从选中 binding 读取 `turn/end`，否则使用显式错误详情或通用未知停止提醒。`completionUnread` 既不触发注意提醒，也不把停止归类为成功。Client binding 的确切窗口形状仍未验证。当前源码级契约见 [SPEC.md](../SPEC.md)。
