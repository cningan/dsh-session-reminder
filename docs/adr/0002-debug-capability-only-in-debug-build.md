# 调试能力只在调试构建中存在

诊断文本块、探针与测试模式是排查"提醒为什么没到"的关键手段，但它们不该出现在用户安装的包里。所以源码保留完整的调试能力，由构建期常量 `__DEBUG__` 决定是否进入产物：`npm run build:client:debug` 产出带调试 UI 与 `sendProbe`/`sendProbeBurst`/`setTestMode` 的 bundle 供本地排查；`npm run build:client`（`prepack` 默认，也是 `npm pack` 走的那条）产出不含任何调试页面与调试 API 的正式包。`npm test` 通过 `pretest` 先构建调试版覆盖调试能力，`npm run check:production` 断言正式产物无调试残留。

代价是调试能力被编译期剥离——无法在正式包上临时开启；需要调试时得重新构建并安装调试版（`build:client:debug` + `plugin_manager` 重装）。

## Consequences

诊断**上报**（写入 profile 的 `.dsh-session-status/diagnostics.jsonl`）不随调试 UI 一起裁剪：它是审计能力，对用户不可见却让维护者事后读账，正式包保留。
