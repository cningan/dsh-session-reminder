# 07: 诊断契约没有 owner：同一套 wire 语义被三处各自理解

**Status:** done — commit dae29d5
**Blocked by:** None（可立即开始）
**Source:** GitHub #2（已从 GitHub 迁入本地工作系统）

## 摩擦

`reportDiagnostic(event, payload)` 是 stringly-typed 的 seam：发送方约 10 处调用、6 类事件名，`edge` 的载荷形状还随分支变化；Host 半边原样存 `payload`（无 schema，无法拒绝漂移）。

读方 `scripts/check-diagnostics.mjs` 反过来重新推导语义（`channel === "suppressed-foreground"`、`payload.kind === "terminal"`、`suppressed != null`、`delivered === true`），并用 `.find()` 的调用顺序编码了一套「判定优先级」——这套规则不在任何 module 里。退出码 0/1/2/3 在脚本头、`SPEC.md`、`README.md` 三处各写一份。

**Deletion test**：删掉读方，这些知识只剩发送方的注释；删掉发送方，读方退化成含义有五种可能的 `NO-DATA`。

## 期望

给这条流一个 owner：事件词表与每种事件的载荷形状集中在一处，发送方与读方共用；sink 追加前校验；读方只解释它认识的事件。同时让记录自带「由哪种构建产生」（正式产物被压缩且不含调试能力，它与调试构建不是同一台观测仪器）。

## 收益

- JSONL 从「只能靠重放真实运行来验」变成可用固定样本喂入的 interface
- 四类结论只有一个来源
- `reportDiagnostic` 调用点收敛

## 来源

架构审查报告（走查员候选 4，Worth exploring；若同时做候选 3 可升级为 Strong）。

## Comments

**cningan · 2026-09-26T18:03:24Z**

重构期间复核：**部分解决**。`06-client-diagnostics-sink.md` 把事件名收敛为 DIAGNOSTIC_EVENTS 常量表、`02-platform-event-reader.md` 把退出码收敛为读方脚本的 VERDICTS 单一来源并让 platform 事件有了读方。**未做**的是给这条 wire 语义一个**共享 module**：Client 的发送形状、Host 的落盘/校验（目前无入站 schema，坏记录静默落盘）、脚本的读方语义仍三处各自理解；记录也仍未标注「由哪种构建产生」（正式产物被压缩且不含调试能力，与调试构建不是同一台观测仪器）。

**cningan · 2026-09-26T19:45:47Z**

已由 commit dae29d5 完成：诊断契约收口为 lib/diagnostics-contract.mjs（Host / scripts / Client 三边共用）——事件词表 + client: 前缀规则 + 每种事件的载荷最小形状 + envelope（新增 build 标明产生它的构建）。Host 落盘前校验：坏记录 400 + rejected 计数 + 一条 diagnostics-rejected 记录；读方只解释认识的事件，形状漂移降级为 SHAPE-WARN、不改结论。既有字段逐字节不变、未知字段与缺席 build 容忍（Client 与 Host 可各自独立升级）。**取舍决定（保持现状）**：attach 的 required 为空集——读方不读它的任何字段，强制必填会把『新增字段』变成破坏性变更，违背契约的『只向前加字段』。代价是 attach 缺字段不被闸门拒绝，已在 SPEC 记录。
