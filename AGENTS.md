# 仓库 Agent 指令

在本仓库采取任何行动之前，先读 [README.md](README.md)（中英双语）、[SPEC.md](SPEC.md)（统一规格）与 [CONTEXT.md](CONTEXT.md)（词汇表）。交接文档按技能惯例写入系统临时目录，不放在仓库内。

- 绝不通过 `cordis_inspect_query` 调用 Client Inspect。
- 有效的自动通知 E2E（端到端）测试必须使用全新、普通的 DSH 用户会话，并且在 DSH 页面/窗口隐藏或失焦时结束。当前正在构建的会话、子 Agent、单元测试和前台设置自检都不满足该测试。
- 不要修改 DSH 核心/preload 或 Profile 挂载配置；用户已拒绝核心变更。保留 Profile 中任何既有的 `cordis.patch.yml` 修改。
- 在真实会话停止的用户可见自动通知得到确认之前，不要声称 E2E 成功，也不要推送到 GitHub。单元测试通过并不足够。
- 源码与提交都保留在本插件仓库内。不要暂存 Profile 运行时数据或其 Git 变更。

## Agent skills

### Issue tracker

本仓库的 issue 与规格以 GitHub issues 承载，用 `gh` CLI 操作。见 `docs/agents/issue-tracker.md`。

### Triage labels

五个 triage 角色使用默认标签（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文（single-context）：根 `CONTEXT.md` + `docs/adr/`，二者均在需要时惰性创建。见 `docs/agents/domain.md`。
