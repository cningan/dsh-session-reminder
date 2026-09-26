# 14: dsh.client.inject 里 slots/sessions 的提供方包名未经运行时验证

**Status:** needs-info
**Blocked by:** None（可立即开始）
**Source:** GitHub #13（已从 GitHub 迁入本地工作系统）

## 发现

`lib/client/assembly.mjs` 的 `CLIENT_DEPENDENCIES`（本地服务名 → 官方包名，`inject` 与 `package.json` 的 `dsh.client.inject` 都由它派生）里，`slots` 与 `sessions` 的**提供方包名**记为 `@deepseek-ai/dsh-client-runtime`。该名字是从既有 `package.json` 沿袭的，但在当前运行时（DSH 0.1.7-rc.2）的打包清单里**找不到这个包**——只有文档散文提及过；实际提供 `slots` 的看起来是 `@deepseek-ai/dsh-client-ui-slots`。

## 为什么当时没改

Harness 文档写明 `dsh.client.inject` 的条目「only order activation and stay allowed」，即未知条目大概只是不生效而无害。所以抽装配层那一票只建立了「两处名单逐项一致」的校验，**没有改动名单本身**——改激活顺序属于越权，且没有运行时验证就改包名等于用猜测换另一个猜测。

## 需要什么

- 在真机上确认 `slots` / `sessions` 服务的实际提供方包名（例如从 profile 的激活清单或运行时服务注册处读，而不是从文档散文推断）。
- 若确认包名有误，更新 `CLIENT_DEPENDENCIES` 并让交叉校验测试跟着锁定；同时确认改动**不影响激活顺序**（这是该字段的唯一语义）。
- 顺带确认 `locale` / `connection` / `uiSession` 三项的包名是否同样未经运行时验证。

## 验收标准

- [ ] 五个服务项的提供方包名都在真机上得到确认（或明确标注哪几项无法确认）
- [ ] 若需要改：`CLIENT_DEPENDENCIES` 更新后 `inject` 与 `dsh.client.inject` 仍然逐项一致，交叉校验测试仍绿
- [ ] 改动前后激活顺序不变（或说明为何必须变）

## Comments

**cningan · 2026-09-26T19:16:59Z**

## 已用 asar 目录树查证（无需真机）

读 DeepSeek Harness 的 `resources/app.asar` header（不加载整个归档），共 **278 个 `@deepseek-ai/dsh-*` 包**；再按 header 里的 offset/size 精确读取候选包的 manifest：

| 服务 | 仓库当前声明 | 查证结果 |
|---|---|---|
| `slots` | `dsh-client-runtime` | ❌ **不存在**；真实提供方 **`@deepseek-ai/dsh-client-ui-slots`**（manifest："Slot registry pure core: typed ordinary Slots and reusable Component Factories…"） |
| `locale` | `dsh-client-locale` | ✅ 存在且相符（"Locale plugin: Host-backed preference…"） |
| `connection` | `dsh-client-connection` | ✅ 存在（"Authenticated RPC transport and generation lifecycle"） |
| `uiSession` | `dsh-client-ui-session` | ✅ 存在（"Session Controller adapter for React and session-scoped slots"） |
| `sessions` | `dsh-client-runtime` | ⚠️ **仍未确认**：全量搜索无 `dsh-client-runtime`（只有 `dsh-ptc-runtime` / `dsh-ptc-runtime-node`）。候选是 `dsh-client-ui-session`（Session Controller adapter）或 `dsh-client-store`（"observable and snapshot-store contracts"） |

## 处置

- `slots` 的包名**将修正为 `@deepseek-ai/dsh-client-ui-slots`**（已确证）。
- `sessions` 暂标注为未确认，**不猜值**。该字段按 Harness 语义「only order activation and stay allowed」，未知条目允许且无害，因此不阻塞。
- 若要彻底确认 `sessions`：需读候选包入口源码找服务声明，或在运行中的 Client 上核对服务注册——属真机范畴。

**cningan · 2026-09-26T19:25:21Z**

## 已用 asar 目录树查证（无需真机）

读 DeepSeek Harness 的 `resources/app.asar` header（不加载整个归档），共 **278 个 `@deepseek-ai/dsh-*` 包**；再按 header 里的 offset/size 精确读取候选包的 manifest：

| 服务 | 仓库当前声明 | 查证结果 |
|---|---|---|
| `slots` | `dsh-client-runtime` | ❌ **不存在**；真实提供方 **`@deepseek-ai/dsh-client-ui-slots`**（manifest："Slot registry pure core: typed ordinary Slots and reusable Component Factories…"） |
| `locale` | `dsh-client-locale` | ✅ 存在且相符（"Locale plugin: Host-backed preference…"） |
| `connection` | `dsh-client-connection` | ✅ 存在（"Authenticated RPC transport and generation lifecycle"） |
| `uiSession` | `dsh-client-ui-session` | ✅ 存在（"Session Controller adapter for React and session-scoped slots"） |
| `sessions` | `dsh-client-runtime` | ⚠️ **仍未确认**：全量搜索无 `dsh-client-runtime`（只有 `dsh-ptc-runtime` / `dsh-ptc-runtime-node`）。候选是 `dsh-client-ui-session`（Session Controller adapter）或 `dsh-client-store`（"observable and snapshot-store contracts"） |

## 处置

- `slots` 的包名**将修正为 `@deepseek-ai/dsh-client-ui-slots`**（已确证）。
- `sessions` 暂标注为未确认，**不猜值**。该字段按 Harness 语义「only order activation and stay allowed」，未知条目允许且无害，因此不阻塞。
- 若要彻底确认 `sessions`：需读候选包入口源码找服务声明，或在运行中的 Client 上核对服务注册——属真机范畴。

**cningan · 2026-09-26T19:25:25Z**

已在 commit 0343264 落地：slots 的提供方改为 @deepseek-ai/dsh-client-ui-slots，package.json 的 dsh.client.inject 同步（交叉校验直测仍绿）。sessions 一行保留原值并在源码注释里标注「未经运行时确认」。本票范围缩小为：确认 sessions 的提供方（需真机），故改标 needs-info。
