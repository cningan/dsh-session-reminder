# 05: 投递渠道是 if 链而不是 seam（提醒渠道缺 module 承载）

**Status:** done — commit 344e299
**Blocked by:** None（可立即开始）
**Source:** GitHub #1（已从 GitHub 迁入本地工作系统）

## 摩擦

`CONTEXT.md` 把「提醒渠道」命名为域词，代码里也确实有多个 adapter（`window.dshShell.notify`、`window.chrome.webview.postMessage`、浏览器 `Notification`，外加「无渠道」）——满足「两个 adapter 才是真 seam」的条件，**却没有 seam**。

顺序尝试、前台否决、权限 memo 刷新、`deliveredKeys` 记账、通知 tag 递增、`onshow/onerror/onclose` 平台反馈、诊断上报，全部交织在同一个约 90 行、用延续式 `finish(channel, delivered)` 收口的函数里。

`delivered` 同时表达三件事：「调用过」「平台接受了」「用户看到了」；为了区分它们不得不长出平台反馈，而 `hasNativeShellNotify()` 仍仅凭形状（`typeof notify === "function"`）宣称能力——`SPEC.md` 自己承认这无法验证。

## 期望

把「把一条提醒交给某个渠道」当作 seam：渠道成为有序 adapter 序列，各自声明可用性与投递结果（被拒 / 接受 / 无渠道）；前台否决与记账留在外面。

## 收益

- 每个渠道可单独作为 adapter 测（shell 抛错 → 下一个、两个都抛 → 浏览器），不再需要 vm 假浏览器
- 「能力宣称 vs 投递结果」的区别变得显式可断言
- tag 序号与权限刷新退出投递路径
- 诊断里的 `channel` 词表不再等于每个分支字符串的并集

## 来源

架构审查报告（走查员候选 3，Strong）。审查报告见会话临时文件 `%TEMP%\architecture-review-*.html`。

## Comments

**cningan · 2026-09-26T18:03:22Z**

重构期间复核：**部分解决**。`04-client-delivery.md` 抽出 client/delivery 后，投递结果已显式化（DELIVERY_OUTCOMES 区分 native-bridge / browser / no-channel / browser-error，另有 fellBack 与 errors 列出逐个抛错渠道），调用者不再靠 channel 字符串猜。**未做**的是把渠道做成**有序 adapter 序列**（各自声明可用性与投递结果），目前仍是顺序尝试 + 结果分类。剩余部分可单独评估。

**cningan · 2026-09-26T19:45:50Z**

已由 commit 344e299 完成：渠道做成有序 adapter 序列（CHANNEL_IDS / ADAPTER_RESULTS / createChannelAdapters / runDeliveryChain；每个 adapter 声明可用性与三态结果 accepted|rejected|unavailable），前台否决与 deliveredKeys 记账仍留在装配层；能力/权限派生单一来源（readCapabilities），投递决策与诊断展示消费同一个值。ADR-0001 保持（无 requireInteraction、tag 短且唯一）。三条独立证据：① 直测（会变脸的权限 getter 证明一次投递只派生一次、上报体与决策同源）② 源码防线（lib/**/*.mjs 里宿主能力只允许 delivery.mjs 读）③ 差分定向（旧实现派生 2 次且上报体 denied 与决策 granted 分叉 → 新实现 1 次且 granted）。冻结测试零改动。
