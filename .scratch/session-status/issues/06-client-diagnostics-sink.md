# 06: client/diagnostics-sink：诊断上报抽成模块，事件名收敛为常量

**Status:** done — commit 25bc424
**Blocked by:** 04 — client/delivery：渠道选择与平台事件分离
**Source:** GitHub #8（已从 GitHub 迁入本地工作系统）

## What to build

把诊断上报抽成 `client/diagnostics-sink`，并把事件名收敛为模块内常量（`attach` / `status` / `edge` / `deliver` / `platform` / `source-shape`），调用点不再散写字面量。上报失败不得影响提醒行为。

## Acceptance criteria

- [ ] 事件名以常量表导出，调用点只引用常量
- [ ] sink 接口保持 `report(event, payload)`，`fetch` 可注入（测试用数组替换）
- [ ] 直测断言：六类事件各自上报的形状；`fetch` 缺失时不抛
- [ ] 全部测试绿；`npm run check:production` 通过

## Comments

**cningan · 2026-09-26T17:17:17Z**

来自 `03-core-decide-pure-module.md` 的收口点（抽 core/decide 时留下的）：判定已 100% 在 core/decide，但装配层仍保留最小记账（previousRunning / handledRuns）来补写**同形的 edge 诊断记录**——因为 notice 只表达「该提醒」，没有「观察到边沿但不提醒」的通道，而 npm run diagnose 的 FAIL 文案正是为被抑制/静默边沿写的。本票抽 diagnostics-sink 时应收口：让 sink 拥有边沿记录通道（例如 decide 暴露只读的 edges 日志），装配层不再碰 run 边沿。

**cningan · 2026-09-26T17:40:34Z**

已由 commit 25bc424 完成：client/diagnostics-sink 抽出（事件名常量表 + 注入 fetch），delivery/source 接线；`03-core-decide-pure-module.md` 的边沿记录张力按方案 (a) 收口——decide 暴露只读 edges，装配层删掉 handledRuns 与补写循环。npm test 99/99 绿，安全网测试零改动，check:production 通过；差分 debug 20000 步 + production 3000 步零差异（含请求体逐字节），3 个变异体全被捕获。
