# @cningan/dsh-session-status

[English](README.md) | 中文

当前行为、不变量与规格见：[SPEC.md](SPEC.md)。

## 功能

这是一个 DSH Web Client 插件，为**所有已观察到正在运行的会话**发送注意提醒，包括当前未选中的会话。通知会区分等待审批、计划审查或回答，与正常完成、错误/中断或原因暂不可知的停止；原因数据不足时使用通用停止说明，不猜成正常完成；已观察到明确由用户取消的 turn 会静默处理；当前会话的 SessionSnapshot 明确标记为 removed 时静默。若停止边沿到达时列表行缺失，该边沿也会被抑制以避免误报归档/移除；后台会话的 removed 详情不会额外读取。插件不在页面内绘制提醒卡片或状态浮层；全局 DSH 连接断开不等同于会话停止。

只有在对应的 DSH 页面/窗口隐藏或失焦时才发送会话提醒；是否当前选中该会话不影响监视范围。点击浏览器通知会请求 DSH 打开对应会话并聚焦窗口；原生桥通知的点击路由由外部 workbench 实现，本仓库未验证。设置页自检是有意允许的前台例外；它发送固定测试载荷，不创建或修改会话状态。

插件读取官方会话列表和覆盖所有会话的状态快照；可用时再读取当前选中会话的 SessionSnapshot 与 eventSource。完成未读标记本身既不触发提醒，也不能证明成功；只有已观察到的运行→停止边沿才产生会话提醒，没有 turn/end 原因时仍使用通用说明。不会为了后台会话详情或事件历史而额外打开会话。连接状态只用于重连后重新同步。会话事实与恢复仍由 DSH 持有；插件只维护临时去重和投递能力状态，不持久化会话状态，也不序列化整个会话对象。

## 通知路径

- DSH workbench 里的渠道是一条**有序的 adapter 序列**：先是 `window.dshShell.notify(payload)`，再是 `window.chrome.webview.postMessage(payload)`，最后是浏览器 Notification API。每个渠道自己声明「现在能不能投」与「投出去的结果」（接受 / 被拒 / 不可用）；两个原生桥是可回退渠道（抛错记一笔后交给下一个），浏览器是终局渠道——它负责「无渠道」的措辞（`browser-<权限>` / `browser-unsupported`）与终局拒绝（`browser-error`）。「现在有哪些渠道可用」只有一处派生的答案（`readCapabilities`）：投递决策、投递结果、上报记录与设置区展示消费同一个值，不再各自重算；桥存在只是形状**宣称**，抛错才是被证伪。已检查的 Desktop bundle 没有插件可调用的 flash-only API；其中 `flashFrame` 仅用于内部模态 UI。检查到的 preload 暴露 `dshDesktop`，但未找到通知方法；目标运行时是否额外注入可选的 `dshShell`/WebView 通知桥仍未验证。独立闪烁需要改 DSH 核心/preload，用户选择不改，因此插件保留现有桥接；没有可用桥接或桥接调用均抛错时，才回退到浏览器通知。已暴露但静默无操作的桥接无法由插件识别。
- 没有 workbench 通知桥成功投递时，会在浏览器权限已授予的情况下回退到浏览器 Notification API；直接浏览器访问时该 API 是主要渠道。
- 浏览器通知通过 `silent: false` 请求平台声音，且使用逐条唯一的 `tag`；**绝不设置 `requireInteraction`**。桌面 WebView 下 `requireInteraction: true` 的通知会被平台静默丢弃——构造成功，但平台既不显示、也不触发 `onshow`/`onerror`/`onclose`（2026-09-26 由 A/B 探针实测确认）。因此所有提醒都按系统默认超时自动消失。原生桥载荷不含声音字段，其声音行为由外部 workbench 决定。实际声音仍由浏览器/WebView 与 Windows 设置决定；插件不能覆盖静音、专注助手或音量设置。

Shell 桥的实现属于外部集成边界，不包含在本仓库中。

## 包入口

- 包名为 @cningan/dsh-session-status，版本 0.3.1；manifest 将其标记为 private。
- lib/index.js 是 Host 半边：注入 `webServer`，持有诊断落盘端点（`/plugins/dsh-session-status/diagnostics`），把 JSONL 记录追加到 profile 下的 `.dsh-session-status/` 目录；它不参与"何时该提醒"的判定。
- lib/client.js 是可由 DSH loader 加载的 Client bundle，并注册会话通知能力与插件设置区（section）。

包声明 `dsh.bundle.patch`（`cordis.patch.yml`），官方渠道才会把它识别为 bundle：用 `plugin_manager` 的 `install_bundle`（或客户端「添加插件」）安装，自带 patch 会挂载本包自己的条目（`id: session-status`、`name: '@cningan/dsh-session-status'`）。安装输入用本地 `.tgz`，内容解包进 profile；不要用目录或 `link:` 形式——那只建 junction，`@deepseek-ai/*` 无法解析。

本仓库是维护源码位置。已部署的 Profile 是外部运行/组合目标；本仓库不手写 Profile 文件（不改 `package.json` 或 `dsh.profile.bundles`）。

## 启用与自检

打开插件设置页，找到其中的「会话提醒」区（注册于 `settings.section`）。提醒文案与设置区经官方 locale 服务跟随 DSH 界面语言。该区会显示已识别的 workbench 桥接或浏览器通知权限状态；如果桥接缺失，仍可在支持时启用浏览器通知。使用 Send test reminder 测试当前可用的提醒路径。

`desktop` Profile 现已经官方渠道、以本地压缩包安装该插件。自动会话停止通知仍需在独立 DSH 会话中做端到端验证；设置自检和单元测试不能替代该验证。

## 诊断

Client 半边把它观察到的事实（装载快照、会话/状态数据源形状、运行边沿、前台判定、投递结果，以及平台自己的通知生命周期事件）上报给 Host 半边，后者追加写入 `<profile>/.dsh-session-status/diagnostics.jsonl`；Host 加载时还会先写一条 `host-ready`，用来区分"Host 没跑起来"与"Client 没上报"。事件词表、每种事件的载荷最小形状与记录 envelope 有**唯一 owner**（Client 发送方、Host 与读方消费同一份）；Host 是**闸门**——落盘前校验，形状不符的记录不再静默写入：请求得到 400（带回累计拒绝条数），同一份 JSONL 里留下一条 `diagnostics-rejected` 事实。每条 Client 记录还标明产生它的构建（`build`）：产物被压缩，且测试能力移出后它已是唯一的观测仪器（记录标 `production`；`debug` 保留为读方认识的历史取值），Host 自己写的行标 `host`。契约只向前加字段——既有字段与取值逐字节不变，未知字段与缺席的 `build`（旧 Client）都被容忍，因此 Host 与 Client 可以各自独立升级。读方因此容忍未知字段，并且**只解释它认识的事件**（Host 行或没见过的名字只出现在事件直方图里）。运行 `npm run diagnose`（或 `node scripts/check-diagnostics.mjs <文件>`）读取该文件并给出结论与退出码。**结论词与退出码语义的唯一定义是 `scripts/check-diagnostics.mjs` 头部文档中的 `VERDICTS` 表**，本文档刻意不复述它们。读方区分「投递调用成功」（`delivered: true`，即 `new Notification()` 没抛错）与「平台确认显示」（同一 key 的 `onshow` 或 `onclose`）：只有后者才是 [ADR-0001](docs/adr/0001-no-require-interaction-short-unique-tags.md) 所依赖的证据。调用成功但该 key 没有任何平台事件时给出"未确认"结论、绝不报告成功；出现 `onerror` 时给出平台拒绝结论并附上 error 文本。这样一次运行可以事后审计，而不必盯着窗口等它结束。

## 兼容性

当前 bundle 使用 uiSession.sessionStatus、connection.state、当前 binding 的 eventSource 和官方 SessionSnapshot 错误字段，不依赖未声明的 nodes。Host 的 SessionEventWindow schema 使用 events/target；但 Client binding 的窗口形状与生命周期尚未独立核实。事件不可用或形状不符时退回通用提醒。详见 [docs/compatibility.md](docs/compatibility.md)。

## 构建

`lib/client.js` 是**构建产物**（esbuild 打包，文件头已标注"勿手改"），源码在 `lib/client/`：

只有**一种构建**；测试能力不在本插件里（见 [ADR-0003](docs/adr/0003-test-capability-lives-outside-the-plugin.md)）：

- `npm run build:client` —— 唯一的产物：不含任何测试 UI，但会注册测试服务 `sessionStatusTest`（`ctx.provide`），即仓库内独立 `dev/` 调试插件要 inject 的那条 Hook
- `npm test` —— `pretest` 先构建该产物，测试针对它运行
- `npm run check:production` —— 构建并断言**产物表面**：没有调试痕迹，且有测试服务 Hook（阳性对照）
- `npm run diagnose` —— 读 `<profile>/.dsh-session-status/diagnostics.jsonl`，给出结论与退出码；它与发送方、Host 闸门消费同一份诊断契约，并且只解释它认识的事件
- `prepack` 走同一条构建，因此从 tarball 安装永远不会带上测试代码

## 构建与测试状态

运行 `npm test` 可执行内置 Node 测试，覆盖会话边沿、terminal reason、渠道识别、前台抑制、连接断开误报、插件设置区注册、locale 字典语言跟随、归一化层（标题三段回退、错误详情抽取、列表/状态形状，以及前台判定的四种情形：隐藏 / 失焦 / 可见且聚焦 / 没有宿主页面，外加「只有归一化 module 可以读页面可见性/焦点」的单一来源防线）、投递层的渠道回退与平台事件回灌（只注入最小替身，不模拟整个浏览器；每个渠道都是可独立直测的 adapter，喂一份能力值就能断言它的可用性与三种结果），设置区（只有正常使用者那一行：说明 + 权限/渠道状态 + 发送测试提醒，类名与文案里都没有调试 UI），**测试服务**（前台覆盖三态各自对投递抑制的影响——两个方向都可验证、三态之外的取值按 `auto`、`deliverAdHoc` 与自动提醒共用投递路径与键序号计数器且同样服从前台抑制、订阅/退订、覆盖的影响在上报里看得见），**产物表面**（`Object.keys(model)` 固定、服务经 `ctx.provide` 注册且只有契约的四个方法、产物无调试痕迹但有 Hook 特征作为阳性对照），诊断读方的结论（固定样本 JSONL：平台确认显示 / 平台拒绝 / 未确认三种投递），**诊断契约**（词表、落盘前缀规则、形状表自身良构、合法记录的定点变异逐条被拒、未知字段的前向兼容、envelope 字段顺序、读方只解释它认识的事件、诚实的构建标注，以及真实产物上报的每条记录都通过同一份校验），以及**能力/权限的单一来源**（一次投递只派生一次、设置区那一问与逐渠道可用性取自同一个值，外加「宿主能力只由投递 module 读取」的源码防线）。判定族断言都在这些 Node 直测里；整套浏览器模拟（`vm`）只保留 5 条装配级集成测试（订阅 → 判定 → 文案 → 投递 → 上报），只断言走完整装配路径才能观察的事实。当前 Client 文件本身就是 DSH loader bundle；这些测试不能代替 DSH 集成和真实通知验证。

## 已知限制

- 浏览器通知权限与声音由浏览器/WebView 和操作系统控制。
- 目标 workbench 是否提供通知桥及其呈现方式尚未在运行态验证；检查到的 Desktop preload 未暴露通知方法。
- 停止边沿到达时，如果当前会话没有可用的 turn/end reason 或明确错误信息，会发送“原因未知”的通用提醒。非当前会话不会为读取历史而额外 retain；其 Stop/Cancel/removal 详情不可见，可能仍以通用提醒出现。若停止边沿同时缺失列表行，该边沿会被抑制。
- 持久会话事实和连接恢复仍由 DSH 负责。
