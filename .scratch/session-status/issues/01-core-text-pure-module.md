# 01: core/text：文案字典与语义→文案映射抽成纯模块

**Status:** done — commit 47c0603
**Blocked by:** None（可立即开始）
**Source:** GitHub #5（已从 GitHub 迁入本地工作系统）

## What to build

把文案字典与「语义 → 文案」映射抽成纯 module `core/text`：字典（中/英）与 `terminalText(classified, t)`、`pendingText(kind, t)` 一同迁出 `lib/client/source.mjs`，source 改为引用它们。`t` 由调用方注入，core 不自行获取 locale。

这是九步迁移的第 2 步（第 1 步 `core/classify` 已完成，commit `38850d7`）。

## Acceptance criteria

- [ ] 字典从 `core/text` 导出，locale 注册使用同一份（不再在 source 里重复一份）
- [ ] `terminalText` / `pendingText` 是纯函数：接受注入的 `t`，不读全局
- [ ] 新增 Node 直测：逐 reason 断言中英文案（含 `{reason}` 占位符填充与 `session-open-error` 的空 detail 分支）
- [ ] 全部测试绿（当前基线 39 条），`npm run check:production` 仍通过

## Comments

**cningan · 2026-09-26T17:01:51Z**

已由 commit 47c0603 完成：core/text（字典 + 语义→文案映射）抽出，source 引用它；新增 5 条 Node 直测。npm test 53/53 绿。注意：该 commit 误带了并行票 `02-platform-event-reader.md` 的读方脚本主体（整树暂存），内容完整正确、未改写历史。
