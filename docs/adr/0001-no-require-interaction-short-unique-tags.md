# 通知不使用 requireInteraction，tag 唯一且短

桌面 WebView（Electron / WebView2）下，`requireInteraction: true` 的通知会被平台**静默丢弃**——`new Notification()` 构造成功（我们的代码拿到 `true`），但平台既不显示、也不触发 `onshow`/`onerror`/`onclose`；把会话 id 拼进 `tag`（曾达 94 字符）同样会导致丢弃。因此所有提醒只用系统默认超时（`silent: false` + 逐条唯一的短 tag `dshss-N`），代价是等待/中断类提醒不再"常驻直到用户处理"。

这是 2026-09-26 用 A/B 探针实测确认的（`test-probe:test` 触发 `onshow`，唯一差异是 `requireInteraction` 的 `test-probe:interrupted` 零事件），由 `test/delivery.test.mjs`（通知参数：绝不设置 `requireInteraction`、tag 短且唯一）与 `test/test-service.test.mjs`（`deliverAdHoc` 的载荷与键序号与自动提醒共用同一投递路径）锁定；诊断日志见 `lib/index.js` 的 JSONL sink 与 `scripts/check-diagnostics.mjs`。

## Considered Options

- **保留 `requireInteraction` 让等待/中断提醒常驻**：整条提醒不显示，违反"提醒必须先到达"。
- **放弃系统通知，改成页面内浮层**：页面失焦时用户看不见，等于没有提醒。
