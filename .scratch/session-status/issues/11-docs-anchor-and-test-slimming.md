# 11: 文档去产物行锚 + 契约测试瘦身

**Status:** done — commit dfa8d9d（文档）、332ab04（测试瘦身）
**Blocked by:** 09 — assembly 收口并删除 source.mjs（测试瘦身依赖新模块边界；文档部分可先做）
**Source:** GitHub #12（已从 GitHub 迁入本地工作系统）

## What to build

两件收尾卫生，都在重构主干之外可独立验证：

1. **文档去行锚**：`docs/compatibility.md` 用 `lib/client.js#L212…L783` 这类**产物行锚**，而行数随手写 bundle / 调试构建 / 正式构建变化、全部失效。改用**符号引用**（模块名 / 函数名 / 章节名）。
2. **测试瘦身**：把逐条重建假浏览器的 `vm` 契约测试收敛到装配级 3–5 条（订阅 → 投递 → 上报），判定族由 `core/*` 直测覆盖。

## Acceptance criteria

- [ ] `docs/compatibility.md` 与 README 中不再出现指向产物的行号锚点
- [ ] `test/client.test.js` 只保留装配级集成测试；判定族断言全部搬进 `test/core-*.test.mjs`
- [ ] `npm test` 总时长明显下降，且 `npm run check:production` 通过

## Comments

**cningan · 2026-09-26T18:10:30Z**

两部分均完成：本票文档部分由 dfa8d9d（compatibility.md 去产物行锚，改符号引用）；测试部分由 332ab04（client.test.js 28 条 vm 契约测试收敛为 5 条装配级集成测试，附 28 项覆盖映射，判定族由 core/* 直测承担）。npm test 99/99 绿，安全网测试零改动，check:production 通过。如实报告：总时长未下降（关键路径是 check-diagnostics 的 CLI 子进程与 model-surface），价值在测试面右移而非速度。



- 2026-09-27（维护者）：验收里写的「vm 契约测试收敛到装配级 3–5 条」现为 **7 条**（后续票各加了装配级断言：提醒范围收窄、设置区移除、服务面等）。数量口径随功能演进，属正常；读方以 	`test/client.test.js` 现状为准。

