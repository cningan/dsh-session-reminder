# 09: assembly 收口并删除 source.mjs

**Status:** done — commit 8a0b6b7
**Blocked by:** 08 — client/settings：设置区抽出，调试能力改为显式注入的独立模块
**Source:** GitHub #10（已从 GitHub 迁入本地工作系统）

## What to build

把官方源归一化（`sessions.list` / `uiSession.sessionStatus` / `adapter.current` / `connection.state` → 领域快照）与订阅装配收敛到 `client/assembly`，`entry.mjs` 指向新装配，**删除 `lib/client/source.mjs`**。构建产物与 loader 契约不变。

## Acceptance criteria

- [ ] `lib/client/source.mjs` 不再存在；文件名不再撒谎
- [ ] 归一化在 assembly 内，官方字段读取只出现在这里（core 与 delivery 不读官方源）
- [ ] 构建产物仍是 loader-ready bundle；`npm test` + `npm run check:production` 全绿
- [ ] `inject` 服务清单单一来源（与 `package.json` 的 `dsh.client.inject` 交叉校验）

## Comments

**cningan · 2026-09-26T18:02:48Z**

已由 commit 8a0b6b7 完成：装配收敛为 client/assembly（git mv 保历史），source.mjs 从磁盘与 index 删除，去掉无消费者的 CommonJS 拟态，CLIENT_DEPENDENCIES 成为 inject/dsh.client.inject 的单一来源并有交叉校验直测。npm test 121/121 绿，check:production 通过，loader 契约实测（plugin = {apply, inject}、无 module/exports/require），差分 5 变体 x 320 步零差异。
