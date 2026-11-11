# 18: 后台会话正常结束也报「原因未知」

**Status:** done
**Blocked by:** None
**Source:** 用户反馈（2026-11-11 12:27，0.5.0 已装、应用已重启）

## 摩擦

用户报告：仍然偶尔出现「无法识别原因」的中断提醒，而且基本都发生在对话正常结束时。

诊断日志（`~/.dsh/profiles/desktop/.dsh-session-status/diagnostics.jsonl`，0.5.0 之后）四条终端投递：

```
01:09:46  interrupted  session-0230744e...  isCurrent=false
01:29:48  completed    session-bea5a25a...  isCurrent=true
01:32:45  interrupted  session-bea5a25a...  isCurrent=false
01:45:50  interrupted  session-0230744e...  isCurrent=false
```

`interrupted` 为**一**条就是「无法确定原因」。四条里三条是后台会话，唯一 `isCurrent=true` 的那条原因正确。

## 根因

`lib/core/decide.mjs` 的停止分类只认选中会话的事实：

```js
const selected = sessionId === currentId ? current : undefined;
const stop = classifyStop(selected);
```

`classifyStop(undefined)` 必然返回 `{ reason: "interrupted" }`。也就是说**后台会话的停止原因从来没被读过**——不是"读不到"，是"根本没去读"。这与用户"基本都是正常结束"的观察完全吻合：后台跑完的会话一律落到兜底文案。

同时暴露出第二个问题：兜底文案写的是「会话已中断或停止」，等于对一个未必成立的结论（中断）做了断言。

## 方案

1. **best-effort 读后台会话自己的 scope**：官方 `sessions.binding(id)` 对任何**已具体化**的 scope 都返回绑定（实现是 `scopes.get(id)?.binding`，不会创建 scope）。用户在这个窗口里打开过的会话，事件窗口与详情都还在——直接读，把 `turnEnd`/`detail` 挂到该会话的领域快照上（`session.scope`）。
   - 只对**已停止**的会话读；运行中的会话不做多余读取。
   - 窗口里最后一个轮次边界必须是 `turn/end`（新增 `readLastTurnBoundary`），否则那个 turn/end 属于上一轮，不能拿来冒充这一轮。
   - `sessions.binding` 缺失或抛错 → 没有事实，退回兜底。
2. **判定核心按会话取 scope**：`scopeOf(sessionId, session)` = 会话自带的 `scope` ?? 选中会话的 `current` ?? undefined。`hasTurnEndReason` 也从"整轮的选中会话"改成**逐条边沿**自己的事实。
3. **兜底文案不再断言中断**：「会话已中断或停止 / 会话已停止，但无法确定原因」→「会话已结束（原因未读取）/ 已结束，但没有读取到结束原因」。

## 验证

- 新增 4 条直测：后台边沿用自身 scope 得 `completed`；无 scope 时仍未知且边沿记录 `hasTurnEndReason=false`；文案中英都不出现「中断」；装配层端到端（后台会话带 binding → 通知标题「本轮会话已完成」）。
- `npm test` 162/162 绿；`check:production` 通过。

## 仍未覆盖

后台会话若**从未在本窗口打开**（例如在另一个窗口跑的），官方 `binding(id)` 返回 undefined，仍然读不到原因——此时文案是「原因未读取」，不再是「中断」。要彻底解决需要 `sessions.retain(id)` 主动打开作用域，那是每个会话一次历史加载，SPEC 明确不做，留给下次权衡。
