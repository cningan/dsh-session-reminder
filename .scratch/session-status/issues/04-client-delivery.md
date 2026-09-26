# 04: client/delivery：渠道选择与平台事件分离

**Status:** done — commit 26eab00
**Blocked by:** 03 — core/decide：判定核心抽成纯模块 observe(snapshot) → notices
**Source:** GitHub #7（已从 GitHub 迁入本地工作系统）

## What to build

把投递从判定里分离成 `client/delivery`：渠道选择（`window.dshShell.notify` → `window.chrome.webview.postMessage` → 浏览器 `Notification`）、平台事件回灌（`onshow`/`onerror`/`onclose`）、通知 tag 与权限读取，全部集中到这个 module；前台否决与 `deliveredKeys` 记账留在调用方。诊断上报通过注入的 sink 交给后续步骤。

## Acceptance criteria

- [ ] 渠道选择与平台事件在同一 module，接口不含判定语义
- [ ] 直测或装配级测试覆盖：shell 抛错 → 回退 WebView、两个桥都抛 → 回退浏览器、权限未授予 → 不投递
- [ ] 不回归 ADR-0001：不设置 `requireInteraction`、tag 唯一且短
- [ ] 全部测试绿；`npm run check:production` 通过

## Comments

**cningan · 2026-09-26T17:25:24Z**

已由 commit 26eab00 完成：client/delivery 抽出（渠道顺序 + 平台事件 + tag/权限 + 注入式 report sink），装配层保留前台否决与 deliveredKeys。npm test 86/86 绿，test/client.test.js 零改动（安全网完好），check:production 通过。行为不变由 12000 步差分零差异 + 3 组突变测试（检查器有牙齿）证明。
