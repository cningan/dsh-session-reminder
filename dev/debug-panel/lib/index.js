/**
 * Host 半边：故意是空的。
 *
 * 这个包只做一件开发阶段的事——在设置页渲染调试面板，而面板全部在 Client 半边
 * （`src/` → `lib/client.js`），运行时事实（边沿、投递、前台判定）由主插件
 * `@cningan/dsh-session-status` 的 Host 半边落盘。所以这里没有路由、没有状态、没有
 * `inject`：注册一个 bundle 需要的 `apply` 就够，任何别的东西都只会是发布包里没有的
 * 复杂度（本包不发布，见 ../README.md）。
 *
 * 之所以仍然要有这一个文件：`package.json` 的 `main` / `exports["."]` 指向 Host 入口，
 * 官方安装渠道把一个 bundle 当成普通插件加载，缺了它就装不上、面板也就没有寄主。
 */

/** 无 Host 侧行为：面板是 Client 半边的事。 */
export function apply() {}
