# 12: 装配层归一化缺少直测：titleOf 标题回退与 openError 字段抽取

**Status:** done — 并入 13 后由 commit fd1bf4f 落地
**Blocked by:** None（可立即开始）
**Source:** GitHub #14（已从 GitHub 迁入本地工作系统）

## 缺口

契约测试瘦身（`11-docs-anchor-and-test-slimming.md`）时发现，装配层的两处**官方源归一化**没有直测覆盖，且这不是瘦身删出来的——原来的 28 条 vm 契约测试里也没有一条断言过它们：

1. `detailShapeOf`：把官方 `SessionSnapshot` 的错误字段抽成领域形状（`promptError.error.code/message`、`openError.code/message`）。瘦身时补了一轮 `promptError`（`E_NET: offline`），但 **`openError` 的字段名仍无断言**（`lastAgentError` 由 `04-client-delivery.md` 的直测覆盖）。
2. `titleOf`：标题回退链 `displayTitle → title → sessionId`，**完全没有覆盖**。

## 为什么值得修

这两处正是"上游契约形状"与"我们的领域形状"之间的翻译层——上游改名时，它们是最先坏的地方，而且坏了不会报错，只会让提醒的文案或标题悄悄退化。它们现在只在装配级集成测试里被间接带过。

## 建议做法（二选一）

- **抽成纯函数**（推荐）：归一化本来就该是可直测的纯函数——入参是官方快照片段，出参是领域形状；抽出来后按 core/* 的方式直测，不必走 vm。
- 或在装配层集成测试里补断言（标题回退三种情况 + `openError` 字段名）。

## 验收标准

- [ ] `titleOf` 的三段回退各有断言（`displayTitle` 优先、回退 `title`、再回退 `sessionId`）
- [ ] `openError` 的 `code` / `message` 抽取有断言（含两者都缺时的空串分支）
- [ ] 若选择抽成纯函数：装配层改为调用它，装配级集成测试仍全绿

## Comments

**cningan · 2026-09-26T19:15:29Z**

已合并进 `13-foreground-single-source.md`（同属装配层收尾，一起做更省事）：`13-foreground-single-source.md` 负责前台判定单一来源，本票的 titleOf 回退与 openError 抽取直测一并纳入。合并后按 `13-foreground-single-source.md` 跟踪。
