# 02: 修 platform 事件无读方（ADR-0001 的证据链断点）

**Status:** done — commit 0471843
**Blocked by:** None（可立即开始）
**Source:** GitHub #11（已从 GitHub 迁入本地工作系统）

## What to build

修掉走查员发现的真实缺陷：**`platform` 事件（`onshow` / `onerror` / `onclose`）没有任何读方**——它是 ADR-0001「通知是否真的显示」赖以成立的证据，但 `scripts/check-diagnostics.mjs` 不解析它，导致这条证据只能靠人眼翻 JSONL。

让回路脚本认识该事件：把「平台确认显示」纳入结论与退出码（例如无 platform 事件时结论不得为 OK，或单列一类结论），并更新脚本头部、SPEC、README 里三处重复的退出码说明。

本票**独立于**判定核心重构，可立即开始。

## Acceptance criteria

- [ ] `check-diagnostics.mjs` 解析 `client:platform` 记录，并在结论中区分「调用成功」与「平台确认显示」
- [ ] 退出码语义在脚本头、SPEC、README 中**只写一份**（其余引用它）
- [ ] 用固定样本 JSONL 直测：有 `onshow` / 有 `onerror` / 无任何平台事件 三种输入给出不同结论
- [ ] 全部测试绿

## Comments

**cningan · 2026-09-26T17:01:54Z**

已由 commit 0471843 完成：platform 事件有读方，结论区分「调用成功」与「平台确认显示」，退出码收敛为脚本 VERDICTS 单一来源；新增 9 条固定样本直测。实测 diagnose 对线上 JSONL 输出 VERDICT: OK（平台确认显示）。
