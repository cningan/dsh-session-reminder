# 03: core/decide：判定核心抽成纯模块 observe(snapshot) → notices

**Status:** done — commit ca82303
**Blocked by:** 01 — core/text：文案字典与语义→文案映射抽成纯模块
**Source:** GitHub #6（已从 GitHub 迁入本地工作系统）

## What to build

把「会话快照 → 提醒」的判定抽成纯 module `core/decide`，接口是 `observe(snapshot) → notices`：判定状态（上一轮快照、run 序号、等待去重键）由 core 自己持有，调用者只喂归一化后的领域快照（`sessions[{ id, title, running, pending, unread, inList }]`、`currentId`、`background`、`turnEnd`）。输出是语义枚举 `{ sessionId, kind: pending|terminal, reason, detail }`，不含文案。

`source.mjs` 改为调用它（归一化与订阅仍留在 source，后续步骤再迁）。

## Acceptance criteria

- [ ] `core/decide` 是纯 module：无 DOM、无 `fetch`、无 locale；状态自持
- [ ] 直测覆盖：运行→停止边沿、仅列表行消失不触发、等待优先于停止、等待对象同一性去重、缺失列表行抑制、每 run 至多一次、新 run 重置抑制、连接断开不触发
- [ ] `source.mjs` 的判定行为不变（现有契约测试仍绿）
- [ ] 全部测试绿；`npm run check:production` 通过

## Comments

**cningan · 2026-09-26T17:17:15Z**

已由 commit ca82303 完成：core/decide（observe(快照) -> notices，状态自持）抽出，source 接线，新增 23 条 Node 直测；npm test 76/76 绿，check:production 通过。行为不变由 A/B 差分等价证明（新旧 bundle 同喂 12000 步，noticeDiffs=0 / reportDiffs=0）。
