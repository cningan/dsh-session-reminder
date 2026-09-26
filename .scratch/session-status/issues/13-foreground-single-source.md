# 13: 承重前置条件「前台窗口」有两份实现

**Status:** done — commit fd1bf4f
**Blocked by:** None（可立即开始）
**Source:** GitHub #3（已从 GitHub 迁入本地工作系统）

## 摩擦

整条插件的不变式「仅在前台之外投递」依赖 `pageIsBackground()`，但它是投递最内层对 `document` 的全局读取；**同一个判定在设置区被内联复刻了一份**用于渲染诊断行。同一不变式的两个 adapter 分居两层——今天一致，但没有任何东西维持它们一致（UI 可能显示「失焦判定 否」，而真正决定投递的是另一个表达式）。

能力/权限同理：三处调用 `readNotificationPermission(!nativeBridgeFailed)`、两处直接读 `readBrowserNotificationPermission()`、一处读 memo，`getSnapshot()` 展示的值与最后一次决策所用的值可以不同。

## 期望

由一处回答「这个页面现在是否在前台」、一处回答「现在有哪些渠道可用」，且这两个答案作为值流入判定与诊断展示，而不是在每个使用点各自重算。

## 收益

- 承重前置条件变成可注入的输入 → 现有 4 条前台相关测试与 3 条渠道识别测试全部脱离 `document`/`window` 模拟
- UI 的诊断行变成「可断言与投递决策同源」
- 能力/权限派生只需断言一处

## 来源

架构审查报告（走查员候选 5，Worth exploring；改动面最小、可先摘）。

## Comments

**cningan · 2026-09-26T18:03:21Z**

重构期间复核：**本问题仍然存在**。前台判定现在有两处实现——`lib/client/assembly.mjs` 的 pageIsBackground（真正决定投递）与 `lib/client/debug-tools.mjs` 里内联复刻的同一表达式（只用于渲染诊断行）。两者今天一致，但仍无任何机制维持一致。（注：assembly 另有两处上报 visibility/focused 观测值，那是忠实记录事实而非复刻判定，不算重复实现。）

**cningan · 2026-09-26T19:15:27Z**

**并入 `12-normalize-direct-tests.md` 的范围**（工单合并，避免过碎）：本票现在同时负责装配层收尾的三件事——① 前台判定单一来源（不再两处实现）；② `titleOf` 标题回退（displayTitle → title → sessionId）直测；③ `openError` 字段抽取直测。做法倾向：把官方源归一化抽成可直测的纯函数（入参官方快照片段，出参领域形状），装配层与设置区都消费同一份前台判定结果。

**cningan · 2026-09-26T19:25:18Z**

已由 commit fd1bf4f 完成：新增 client/normalize（归一化纯函数）与 readPageState（前台判定唯一实现），assembly 后台事实以值流入否决策略/诊断/上报/投递；debug-tools 不再读 document。原 `12-normalize-direct-tests.md` 的 titleOf 三段回退与 openError 抽取直测一并落地。npm test 109/109 绿，冻结测试零改动，check:production 通过；差分 160 帧 x 调试/正式零差异，阳性对照证明比较器对该承重前提敏感。剩余部分（能力/权限派生散落多处）并入 `05-delivery-channel-adapters.md` 批次处理。
