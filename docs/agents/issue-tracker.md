# Issue tracker: GitHub

本仓库的 issue 与规格以 GitHub issues 承载，所有操作使用 `gh` CLI（仓库自动从 `git remote -v` 推断；无需在命令里写仓库名）。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`；多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`；可用 `jq` 过滤评论并读取 labels。
- **列出 issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` 与 `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`
- **应用 / 移除标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

## Pull requests 作为请求面

**PRs as a request surface: no.**（若将来把外部 PR 也当作功能请求，改为 `yes` 并按 PR 等价命令处理；`/triage` 会读取此标记。）

## 当技能说 "publish to the issue tracker"

创建一条 GitHub issue。

## 当技能说 "fetch the relevant ticket"

运行 `gh issue view <number> --comments`。
