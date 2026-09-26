# 08: client/settings：设置区抽出，调试能力改为显式注入的独立模块

**Status:** done — commit f4b9211
**Blocked by:** 06 — client/diagnostics-sink：诊断上报抽成模块，事件名收敛为常量
**Source:** GitHub #9（已从 GitHub 迁入本地工作系统）

## What to build

把设置区（React 组件、CSS、locale 绑定、设置行状态机）抽成 `client/settings`；**调试能力（诊断文本块、探针、测试模式）改为独立 module，由装配层在 `__DEBUG__` 下显式注入**——这样 model 的表面在正式构建与调试构建里一致（走查员指出的「interface 随构建标志变化」）。

## Acceptance criteria

- [ ] 正式构建与调试构建下 model 暴露的键一致（调试工具作为独立协作者注入）
- [ ] 设置区行为不变：插件配置页 section、文案跟随 locale、自检按钮可用
- [ ] `npm run check:production` 仍然断言正式产物不含调试 UI 与探针 API
- [ ] 全部测试绿

## Comments

**cningan · 2026-09-26T17:53:26Z**

已由 commit f4b9211 完成：client/settings 与 client/debug-tools 抽出，调试能力从 model 表面移走、改为装配层显式注入；model 公开面在两种构建里一致（getSnapshot/subscribe/requestPermission/sendTestNotification 四键）。npm test 118/118 绿，check:production 通过；差分 5 变体 x 320 步逐字段零差异（含设置区元素树、样式表、控制台记录、model 键集合）。
