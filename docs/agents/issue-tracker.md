# Issue tracker: Local Markdown

本仓库的 issue（票）以**工作区内的本地 Markdown 文件**承载，与 spec 放在一起；GitHub issues 不再是本仓库的 issue tracker（旧的 GitHub issue 内容已迁入本地）。

## 位置与结构

- 一个 feature 一个目录：`.scratch/<feature-slug>/`。
- spec：本仓库**沿用仓库根的 `SPEC.md`**（统一规格模板），**不**放在 `.scratch/<feature-slug>/spec.md`。这是本仓库对该模式默认布局的唯一偏离——统一规格模板要求 spec 位于仓库根，**不要**为了套模板而搬动 `SPEC.md`。
- 票：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，**一张票一个文件**，从 `01` 开始编号；**绝不**把所有票合并成一个 `tickets` 文件。
- 当前 feature：`session-status`（即插件名），票在 `.scratch/session-status/issues/`。
- 编号按**依赖顺序**排：blockers 在前，被阻塞的票编号更大。

## 票的文件结构

```md
# NN: <标题>

**Status:** <triage 角色，或 done — <依据>>
**Blocked by:** <本地编号与标题，或 "None（可立即开始）">
**Source:** GitHub #<原编号>（已从 GitHub 迁入本地工作系统）

<正文：目标 / 背景 / 验收标准等>

## Comments

<按时间顺序追加的评论与对话历史；没有则省略该段>
```

## 约定

- **创建票**：新建 `.scratch/<feature-slug>/issues/<下一个 NN>-<kebab-slug>.md`，按上面的结构写；编号取目录内当前最大编号 + 1。
- **读取票**：直接读对应文件本身（含底部 `## Comments`）。
- **列出票**：列 `.scratch/<feature-slug>/issues/` 目录并按文件名排序；需要筛状态就读各文件靠上的 `Status:` 行。**不要**另建索引/台账文件（见本目录 `domain.md` 与仓库根 `AGENTS.md`：不建根级 TODO 台账）。
- **评论**：在该文件底部 `## Comments` 标题下按时间顺序追加一段（带作者与时间），不要改写已有评论。
- **改状态**：改文件靠上的 `Status:` 行；triage 角色取值见 `docs/agents/triage-labels.md`（`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`）。
- **关闭（done）**：把 `Status:` 改为 `done — <依据>`（commit hash 或说明），文件保留，不删除。

## Pull requests 作为请求面

**PRs as a request surface: no.**（若将来把外部 PR 也当作功能请求，改为 `yes` 并按 PR 等价方式处理；`/triage` 会读取此标记。）

## 当技能说 "publish to the issue tracker"

在 `.scratch/<feature-slug>/issues/` 下新建一个票文件（见上「创建票」）。

## 当技能说 "fetch the relevant ticket"

读取 `.scratch/<feature-slug>/issues/<NN>-<slug>.md` 这个文件本身。

## 迁移说明

`.scratch/session-status/issues/01–16` 由 GitHub issues #1–#16 逐条迁入：标题、正文、验收标准、标签、状态与评论全部保留；正文与评论里对 GitHub 编号的引用已改写为对应的本地文件路径。GitHub issues 不再维护——仓库内的 `.scratch/` 是唯一的工作系统，票的编号（`01`–`16`）与旧的 GitHub 编号（`#1`–`#16`）**不是**同一套编号，对照关系记在各文件的 `Source:` 行。
