# 10: source.mjs 搬迁残留：CJS 拟态、服务清单两处、数据与逻辑交织

**Status:** done — 无单一 commit：CommonJS 拟态由 `09-assembly-and-remove-source.md` 删除，字典由 `01-core-text-pure-module.md` 迁出，CSS/组件与诊断文案由 `08-client-settings.md` 迁出；`source.mjs` 已不存在
**Blocked by:** None（可立即开始）
**Source:** GitHub #4（已从 GitHub 迁入本地工作系统）

## 摩擦

- 文件名 `source.mjs` 说的是「被搬过来的那个东西」，不是它是什么。
- `createPlugin` 伪造 CommonJS `module.exports` 并盖上 `Symbol.toStringTag = "Module"`，而 `entry.mjs` 立刻把它拆开——没人消费这个形状，纯拟态。
- 插件的真实表面（`apply`/`inject`）声明在约 1200 行函数体的最后 30 行；`inject` 这份「需要哪些服务」的清单还以另一套词汇在 `package.json` 的 `dsh.client.inject`（4 个 npm 包名）里再声明一次，两处无交叉校验。
- 演示数据（两份字典、约 200 行 CSS、四条中文诊断模板）夹在逻辑前后与内部：想知道「消息怎么拼」和「消息文本是什么」要跨 600 行；诊断模板是唯一绕过 locale 的用户可见文本。
- **Deletion test**：删掉字典/CSS，复杂度消失（它只是数据）——所以它本该是能被忽略的独立 module，而不是同一文件的前 300 行。

## 期望

入口成为真正的 ESM module 并导出插件表面；演示数据与诊断 UI 各自成 module；去掉 CJS 拟态；服务需求清单单一来源。

## 收益

- locality：该文件读起来是状态机而不是文档
- 服务清单只有一处（`inject` 与 `dsh.client.inject` 交叉校验）
- 文件名不再撒谎

## 来源

架构审查报告（走查员候选 6，Speculative：纯卫生，但成本低）。与「抽 core/decide、拆 client/」的重构同批做最省事。

## Comments

**cningan · 2026-09-26T18:03:18Z**

已由重构收尾解决（本票三个子问题全部落地）：① CommonJS 拟态 —— `09-assembly-and-remove-source.md` 删掉（lib 内 toStringTag/module.exports/var exports 计数已为 0）；② 服务清单两处 —— `09-assembly-and-remove-source.md` 引入 CLIENT_DEPENDENCIES 作单一来源，inject 与 package.json 的 dsh.client.inject 都由它派生并有交叉校验直测；③ 数据与逻辑交织 —— 字典迁 core/text（`01-core-text-pure-module.md`）、CSS 与组件迁 client/settings（`08-client-settings.md`）、诊断文案迁 client/debug-tools（`08-client-settings.md`）。source.mjs 已不存在。
