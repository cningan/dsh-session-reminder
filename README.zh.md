# @local/dsh-session-status

[English](README.md) | 中文

当前行为、不变量与代码地图见：[SPEC.md](SPEC.md)。

## 功能

这是一个 DSH Web Client 插件，为**所有已观察到正在运行的会话**发送注意提醒，包括当前未选中的会话。通知会区分等待审批、计划审查或回答，与正常完成、错误/中断或原因暂不可知的停止；原因数据不足时使用通用停止说明，不猜成正常完成；已观察到明确由用户取消的 turn 会静默处理；当前会话的 SessionSnapshot 明确标记为 removed 时静默。若停止边沿到达时列表行缺失，该边沿也会被抑制以避免误报归档/移除；后台会话的 removed 详情不会额外读取。插件不在页面内绘制提醒卡片或状态浮层；全局 DSH 连接断开不等同于会话停止。

只有在对应的 DSH 页面/窗口隐藏或失焦时才发送会话提醒；是否当前选中该会话不影响监视范围。点击浏览器通知会请求 DSH 打开对应会话并聚焦窗口；原生桥通知的点击路由由外部 workbench 实现，本仓库未验证。设置页自检是有意允许的前台例外；它发送固定测试载荷，不创建或修改会话状态。

插件读取官方会话列表和覆盖所有会话的状态快照；可用时再读取当前选中会话的 SessionSnapshot 与 eventSource。完成未读标记本身既不触发提醒，也不能证明成功；只有已观察到的运行→停止边沿才产生会话提醒，没有 turn/end 原因时仍使用通用说明。不会为了后台会话详情或事件历史而额外打开会话。连接状态只用于重连后重新同步。会话事实与恢复仍由 DSH 持有；插件只维护临时去重和投递能力状态，不持久化会话状态，也不序列化整个会话对象。

## 通知路径

- DSH workbench 中依次尝试 `window.dshShell.notify(payload)` 与 `window.chrome.webview.postMessage(payload)`。已检查的 Desktop bundle 没有插件可调用的 flash-only API；其中 `flashFrame` 仅用于内部模态 UI。检查到的 preload 暴露 `dshDesktop`，但未找到通知方法；目标运行时是否额外注入可选的 `dshShell`/WebView 通知桥仍未验证。独立闪烁需要改 DSH 核心/preload，用户选择不改，因此插件保留现有桥接；没有可用桥接或桥接调用均抛错时，才回退到浏览器通知。已暴露但静默无操作的桥接无法由插件识别。
- 没有 workbench 通知桥成功投递时，会在浏览器权限已授予的情况下回退到浏览器 Notification API；直接浏览器访问时该 API 是主要渠道。
- 浏览器通知通过 `silent: false` 请求平台声音。原生桥载荷不含声音字段，其声音行为由外部 workbench 决定。实际声音仍由浏览器/WebView 与 Windows 设置决定；插件不能覆盖静音、专注助手或音量设置。

Shell 桥的实现属于外部集成边界，不包含在本仓库中。

## 包入口

- 包名为 @local/dsh-session-status，版本 0.3.1；manifest 将其标记为 private。
- lib/index.js 是空 Host 入口，不声明 Host 注入，apply 为空函数。
- lib/client.js 是可由 DSH loader 加载的 Client bundle，并注册会话通知能力/设置行。

DSH Profile 通过包名组合此插件。配置行示例：

~~~yaml
- id: session-status
  name: '@local/dsh-session-status'
~~~

本仓库是维护源码位置。已部署的 Profile 是外部运行/组合目标；本次建仓没有修改任何 Profile 配置。

## 启用与自检

打开 Settings → General → Session reminders。设置行会显示已识别的 workbench 桥接或浏览器通知权限状态；如果桥接缺失，仍可在支持时启用浏览器通知。使用 Send test reminder 测试当前可用的提醒路径。

本地 `desktop` Profile 插件副本已更新。自动会话停止通知仍需在独立 DSH 会话中做端到端验证；设置自检和单元测试不能替代该验证。

## 兼容性

当前 bundle 使用 uiSession.sessionStatus、connection.state、当前 binding 的 eventSource 和官方 SessionSnapshot 错误字段，不依赖未声明的 nodes。Host 的 SessionEventWindow schema 使用 events/target；但 Client binding 的窗口形状与生命周期尚未独立核实。事件不可用或形状不符时退回通用提醒。详见 [docs/compatibility.md](docs/compatibility.md)。

## 构建与测试状态

运行 `npm test` 可执行内置 Node 测试，覆盖会话边沿、terminal reason、渠道识别、前台抑制和连接断开误报。当前 Client 文件本身就是 DSH loader bundle；这些测试不能代替 DSH 集成和真实通知验证。

## 已知限制

- 浏览器通知权限与声音由浏览器/WebView 和操作系统控制。
- 目标 workbench 是否提供通知桥及其呈现方式尚未在运行态验证；检查到的 Desktop preload 未暴露通知方法。
- 停止边沿到达时，如果当前会话没有可用的 turn/end reason 或明确错误信息，会发送“原因未知”的通用提醒。非当前会话不会为读取历史而额外 retain；其 Stop/Cancel/removal 详情不可见，可能仍以通用提醒出现。若停止边沿同时缺失列表行，该边沿会被抑制。
- 持久会话事实和连接恢复仍由 DSH 负责。
