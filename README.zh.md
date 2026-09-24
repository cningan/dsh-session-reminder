# @local/dsh-session-status

[English](README.md) | 中文

当前行为、不变量与代码地图见：[SPEC.md](SPEC.md)。

## 功能

这是一个 DSH Web Client 插件，为**当前会话**发送操作系统通知：会话等待审批、计划审查或回答；本轮运行完成；运行因错误、中断或其他终止信号结束；以及 DSH 连接丢失。它不在页面内绘制提醒卡片、toast 或状态浮层；后台会话完成不会触发通知。

通常只有在 DSH 页面隐藏或失焦时才发送通知。点击浏览器通知会请求 DSH 打开对应会话并聚焦窗口；原生桥通知的点击路由由外部 workbench 实现，本仓库未验证。设置页自检是有意允许的前台例外；它发送固定测试载荷，不创建或修改会话状态。

插件读取官方会话列表、当前会话状态/作用域、当前会话详情和连接状态。会话事实与重连仍由 DSH 持有。插件只维护短暂的边沿去重和通知能力状态；不持久化会话状态，也不序列化整个会话对象。

## 通知路径

- DSH workbench 中优先调用可选的 shell 通知桥；原生 Windows 展示和任务栏闪烁由 workbench 负责。
- 直接浏览器访问时，在权限允许的情况下使用浏览器 Notification API。
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

打开 Settings → General → System notifications。workbench 中设置行会报告原生桥是否可用；直接浏览器访问时，可通过设置行启用并授权通知。使用 Send test notification 测试当前可用的通知路径。

部署包改动到 DSH Web Profile 时，按该运行环境已有的插件检查与重启流程执行。本次建仓没有部署到 Profile，也没有进行端到端通知测试。

## 兼容性

当前 bundle 使用 0.1.7-alpha.1 时代的 uiSession.sessionStatus 与 connection.state 契约，没有回退到历史字段名的兼容分支。超出这些契约范围的运行时兼容性为 **UNVERIFIED**；当前没有独立兼容矩阵。详见 [docs/compatibility.md](docs/compatibility.md)。

## 构建与测试状态

当前包没有独立构建或测试流水线：manifest 未声明 scripts，包内也没有 src、test 或 build 目录。已提交的 Client 文件本身就是 DSH loader bundle。可以运行 Node JavaScript 语法检查，但它不能代替 Host/plugin 集成检查或真实通知验证。

## 已知限制

- 浏览器通知权限与声音由浏览器/WebView 和操作系统控制。
- workbench 原生通知依赖可选 shell bridge；其源码与构建流程不在本仓库。
- 如果仅收到 status 边沿而当前会话详情对象尚不可用，当前代码会使用不含错误字段的最小详情快照；若运行实际异常结束，该路径可能将其分类为已完成。较早的说明称其可能显示占位中断原因，但这与当前检查到的源码不符；该边界尚未经过运行态验证。
- 持久会话事实和连接恢复仍由 DSH 负责。
