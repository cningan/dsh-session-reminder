# 开发调试面板 `@cningan/dsh-session-status-debug`

> 这是**仓库内的开发件**（`dev/` 下），**不发布、不进主插件发布包**。因此本文档按仓库惯例
> 以中文单语维护（面向远端生态的双语 README 属于发布包 `@cningan/dsh-session-status`）。

它是主插件 `@cningan/dsh-session-status` 的调试面板：经主插件注册的测试服务
`sessionStatusTest` 渲染一个设置页 section，用来**双向**验证那条承重规则「只有页面隐藏或
失焦时才投递提醒」——

| 覆盖模式 | 点探针的预期 | 证据在哪 |
| --- | --- | --- |
| `跟随真实`（默认） | 与没有本面板时逐字节一致 | 诊断第 4 行的「失焦判定」 |
| `强制前台` | **不弹**，但诊断里留下一条「被前台抑制」记录 | 诊断第 3 行显示 `suppressed-foreground` |
| `强制失焦` | **应该弹** | 诊断第 3 行显示 `browser` / `shell` / `webview` |

旧时代的 `testMode` 只能单向证明「能弹」，证明不了「前台时确实不弹」——这块面板就是为
双向验证而存在的。决定记录见
[ADR-0003](../../docs/adr/0003-test-capability-lives-outside-the-plugin.md)（取代 ADR-0002），
规格见主仓库 [SPEC.md](../../SPEC.md) 的「实现决策」与「范围外」。

## 为什么不在发布包里

主包 `package.json` 的 `files` 是**运行时文件的显式白名单**（`lib/client.js` /
`lib/index.js` / `lib/diagnostics-contract.mjs` / `cordis.patch.yml` / `docs` / `README*` /
`SPEC.md` / `CONTEXT.md`，外加显式的 `"!dev"`），`dev/` 不在其中——源码目录（`lib/client/`、
`lib/core/`、`scripts/`）同样不在，所以发布包里既没有主插件的构建期源码，也没有本面板。
自证方式：在主仓库根执行 `npm pack`，检查 tarball 里没有 `dev/` 条目——

```powershell
npm pack                     # 主仓库根；prepack 会先构建主插件产物
tar -tzf cningan-dsh-session-status-<版本>.tgz | Select-String "^package/dev/"
# 无输出 = 面板不在发布包里
```

## 前置条件

主插件 `@cningan/dsh-session-status` 必须已安装并**处于激活状态**：面板依赖的
`sessionStatusTest` 服务由它经 `ctx.provide("sessionStatusTest", …)` 注册，随它的 fiber
卸载而注销。本插件的 `inject` 已经声明了这个服务，主插件不在时面板不会注册（控制台会留下
一条 `sessionStatusTest is unavailable` 的线索），而不是挂一个没数据的面板。

## 目录

| 路径 | 作用 |
| --- | --- |
| `src/` | 客户端源码（`strings.mjs` 字典 / `panel.mjs` 面板与纯格式化 / `plugin.mjs` 插件表面 / `entry.mjs` loader 入口） |
| `lib/client.js` | **构建产物**（loader 加载的 bundle，不入 git，见 `.gitignore`） |
| `lib/index.js` | Host 半边（故意为空：面板全部在 Client 侧） |
| `scripts/build-client.mjs` | 构建脚本（esbuild / iife / `platform: "browser"` / 压缩） |
| `tests/*.spec.mjs` | 直测（假服务 + 假 React + 产物直测），见下 |

## 构建

```powershell
cd dev/debug-panel
npm run build:client        # 产出 lib/client.js
```

`pretest` 与 `prepack` 都会先跑同一条构建，所以测试与打包前不必手动构建。
esbuild 从仓库根的 `node_modules` 解析即可（本包位于主仓库内，Node 的模块解析会向上找到
根依赖）；把本包单独拿走时才需要 `npm install`。

## 测试

```powershell
cd dev/debug-panel
npm test                    # 或：npm --prefix dev/debug-panel test（从仓库根）
```

覆盖：三态开关把对应 mode 传给 `setForegroundOverride`（且只改结论、不改写宿主证据）、
探针按钮调用 `deliverAdHoc` 并显示结果（test / interrupted / 连发 ×3）、诊断 4 行按快照渲染、
`subscribe` 的订阅/退订与状态变化驱动重渲染、**强制前台时结果提示表明被抑制**、
以及真实产物经 `window.__ModuleLoader__.load` 装进最小假浏览器后的端到端验证。

> 为什么测试文件叫 `tests/*.spec.mjs` 而不是 `test/*.test.mjs`：主仓库的 `npm test` 是
> `node --test`（无参数，按默认规则递归发现 `*.test.*` 与 `test/**`），`dev/` 下的用例会被
> 一并收编进主包统计。`.spec.mjs` + 显式的文件清单让 dev 用例**只**在
> `npm --prefix dev/debug-panel test` 下运行；主仓库的测试统计保持原样。新增用例后要把文件
> 加进 `package.json` 的 `test` 脚本清单。

## 打包成 tarball

```powershell
cd dev/debug-panel
npm pack                    # 产出 cningan-dsh-session-status-debug-0.0.1.tgz
```

tarball 里只有运行时需要的东西（`package.json` / `README.md` / `cordis.patch.yml` / `lib`），
不含 `src/`、`tests/`、`scripts/`（`files` 白名单），也就不会把测试代码带进 profile。

## 安装到 profile

只能用**压缩包的绝对路径**（`.tgz`），不要用目录路径 / `file:` / `link:`——那只会建 junction，
`@deepseek-ai/*` 官方运行库解析不到，插件不会生效：

```powershell
# 在 DSH 会话里让 Agent 执行（plugin_manager 需要 danger-full-access 授权）：
#   install_bundle  target = <本仓库路径>\dev\debug-panel\cningan-dsh-session-status-debug-0.0.1.tgz
```

等价的人工入口：客户端「添加插件」→ 填同一个 `.tgz` 绝对路径。装好后**刷新页面**，设置页的
插件配置区会出现一个标题写着 **DEV** 的 section：「会话提醒 · 开发调试面板（DEV）」。

`cordis.patch.yml` 把它挂成 bundle（`id: session-status-debug`，`name:
'@cningan/dsh-session-status-debug'`）；`package.json` 的 `dsh.client.inject` 点名主插件包，
只为**排序激活**——保证主插件先注册服务，面板再注入它。

## 卸载 / 更新

```powershell
# 卸载：
#   remove_bundle  target = @cningan/dsh-session-status-debug
# 更新：先卸载再安装（重复安装会被 already-installed 拒绝）
```

## 用户拿到手后怎么验证前台抑制规则（三步）

1. **让页面处于前台**（默认就是这个状态），在面板里点 `强制前台`，再点 `探针：测试提醒`。
   预期：**不弹通知**；面板结果提示写「未弹出：测试提醒 被前台抑制…」，诊断第 3 行出现
   `suppressed-foreground · 被前台抑制（未投递）`。
2. **点 `强制失焦`**（宿主页面不必真的失焦），再点同一个探针。预期：**弹出系统通知**；
   诊断第 3 行变成 `browser`（或 `shell` / `webview`）`· 已投递`，结果提示写「已弹出…」。
3. **点 `跟随真实`** 回到不覆盖的状态，然后真的把窗口切到别的应用（或最小化）再点探针：
   预期与第 2 步一致——说明第 2 步的效果来自真实前台事实，而不只是覆盖开关。
   反向也可以验：真的切走窗口后点 `强制前台`，同一个探针会被抑制。

想让自动提醒也走这条路：切走窗口后让任意一个**正在运行的会话**结束或用等待审批，诊断第 2/3
行会各留一条边沿与投递记录；`npm run diagnose`（主仓库）可以事后读这些记录。

## 排错

- **设置页没有这个 section**：主插件是否已安装且激活（它提供 `sessionStatusTest`）；浏览器
  控制台搜 `sessionStatusTest is unavailable`。
- **探针点不动、没有提示**：看诊断第 3 行——没有可用渠道时投递会失败（权限被拒、没有原生桥），
  这与前台抑制是两件事。主插件设置区的「发送测试提醒」也走同一条投递链，可交叉验证。
- **构建失败找不到 esbuild**：在 `dev/debug-panel` 下 `npm install`（仓库根已有 esbuild 时不需要）。
