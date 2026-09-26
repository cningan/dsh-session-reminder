# 16: 提醒范围收窄为父/普通会话：子代理不参与（先实测归属字段可达性）

**Status:** done — commit 3d294c2（归一化层按 `origin === "subagent"` 过滤；可达性证据：`sessions.list` 行 `byId[id].origin`，第一方插件 `dsh-client-ui-workspace` 同款判据，本机子代理会话文件实测 `origin:"subagent"`）
**Blocked by:** None（可立即开始）
**Source:** GitHub #16（已从 GitHub 迁入本地工作系统）

## 背景

用户报告并确认：**子代理会话不应参与提醒**。

现状盘点：
- 判定核心遍历**全部**会话、无任何归属过滤（`lib/core/decide.mjs` 的 `for (const session of sessions)`；`currentId` 只用来打 `isCurrent` 标记）。
- 诊断日志里产生过运行边沿的都是 `session-<uuid>` 形态的会话，另有 12 个裸 uuid 会话**从未 running**、从未产生边沿。所以"子代理到底会不会提醒"目前**没有确凿结论**；能确定的是代码层面**不区分**。
- 规格此前**没有**「哪些会话参与」这一条（已在本票补上）。

## 要做

### 1. 先实测（先于实现，结论要有证据）
客户端插件能否读到会话的归属标记？

- 候选来源：`sessions.list` 的会话行、`sessions.binding(id).session`（`SessionSnapshot`）、或其它 Client 服务。
- 已知证据：Host 侧 `@deepseek-ai/dsh-session` 有 `session.header.origin === "subagent"` 与 `header.parentSession`；客户端侧 `@deepseek-ai/dsh-client-file-upload` 里出现过 `agent.session.header.origin === "subagent"`，说明客户端**存在**可达路径（但那个 `agent` 可能是"当前 agent"，不一定覆盖任意会话）。
- 实测手段不限（临时诊断上报一行 keys、临时探针、或在 `dev/debug-panel` 里临时展示都可以），但**必须在交付里给出证据**（哪个服务、哪个字段、实际观测到的值）。
- **严禁使用 `cordis_inspect_query`**（Client Inspect 被用户禁用，会静默死锁）。可以读 asar 里的包源码来确认接口形状。

### 2. 若可达：过滤
在归一化层（`lib/client/normalize.mjs` → 领域快照）跳过子代理会话，保证：
- 子代理会话**不产出**等待/停止 reminder
- 诊断上也有明确态度：要么完全不产生它的边沿记录（因为它从未进入判定），要么显式记为"因归属过滤而跳过"——你选一种并配测试
- **父/普通会话的行为逐字节不变**（用本仓库惯用的差分验证：改动前后 bundle 同喂随机序列，比较通知 / 上报请求体 / 快照）

### 3. 若不可达：停下报告
说明卡在哪（哪个服务看不到该字段），给出替代方案（例如要求上游在会话行里暴露 `origin`）。**不要**用会话 id 形态做启发式——那只是巧合，不是契约。

## 验收标准

- [x] 新增测试：`origin === "subagent"` 的会话不产出 reminder；普通会话不受影响
- [x] 行为测试全部保持通过，期望值不得放宽
- [x] SPEC 的「提醒范围只覆盖父/普通会话」条目与实现一致（若实测结论要求改写该条目的措辞，一并更新）
- [x] 交付里给出字段可达性的**证据**（服务名 + 字段路径 + 观测值），或"不可达"的具体卡点
- [x] 有条件的话：`dev/debug-panel` 里能看出当前选中会话是否为子代理（可选，便于人工验证）

## 关联

- 规格新增条目「提醒范围只覆盖父/普通会话」。
- 与 `14-inject-provider-package-names.md`（依赖包名）无关。
