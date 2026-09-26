/**
 * 调试面板插件（Client 半边）：把面板挂到设置页（`settings.section`），经主插件注册的
 * 测试服务 `sessionStatusTest` 做前台抑制的**双向**验证。
 *
 * 这是**开发件**：它不进发布包（主包 `files` 白名单里没有 `dev/`），只在开发阶段按
 * [ADR-0003](../../../docs/adr/0003-test-capability-lives-outside-the-plugin.md) 的说法
 * 用 `plugin_manager` 装到 profile。面板本身不读宿主事实、不投递、不判定——那三件事
 * 全在服务那一侧（主插件），面板只消费 `getSnapshot` / `setForegroundOverride` /
 * `deliverAdHoc` / `subscribe` 四个方法。
 *
 * `DEPENDENCIES` 是本地服务名与提供方的**单一来源**：`inject`（本地服务名，运行时注入用）
 * 与 `package.json` 的 `dsh.client.inject`（官方/宿主包名，按 Harness 语义只用于**排序激活**）
 * 都由它派生，`tests/plugin.spec.mjs` 断言两处名单逐项一致。`sessionStatusTest` 是主插件
 * 提供的服务，它的提供方写成主插件包名——只为让装载顺序确定（主插件先注册服务，本插件再
 * 注入），并不 import 那个包。
 */
import { createDebugPanel, installPanelStyle } from "./panel.mjs";
import { LOCALE_NAMESPACE, dictionaries } from "./strings.mjs";

/** 本包名（loader id、slot id、样式表 identity 都用它）。 */
export const PLUGIN_ID = "@cningan/dsh-session-status-debug";

/** 主插件注册的测试服务名（`ctx.provide("sessionStatusTest", …)`，本插件 `inject` 它）。 */
export const TEST_SERVICE_NAME = "sessionStatusTest";

/** 本地服务名 → 提供它的包名（后者只用于排序激活，不 import）。 */
export const DEPENDENCIES = [
  { service: TEST_SERVICE_NAME, provider: "@cningan/dsh-session-status" },
  { service: "slots", provider: "@deepseek-ai/dsh-client-ui-slots" },
  { service: "locale", provider: "@deepseek-ai/dsh-client-locale" }
];

/** 插件注入清单（本地服务名），由上面那张依赖表派生——它是这份名单的唯一定义处。 */
export const inject = DEPENDENCIES.map(({ service }) => service);

/** 主插件在设置页的 section order 是 30；面板紧跟在它后面，一眼能看到两者相邻。 */
export const PANEL_SECTION_ORDER = 31;

export function createPlugin(loadModule) {
  const React = loadModule("react");
  const h = React.createElement;
  const { useEffect, useState } = React;

  function apply(ctx) {
    const service = ctx.sessionStatusTest;
    if (service === undefined) {
      // inject 已经声明了这个服务，正常装载不会走到这里；真走到这里说明主插件没激活，
      // 此时注册一个没有数据的面板只会更让人困惑，直接不注册并留下线索。
      console.error(`[${PLUGIN_ID}] ${TEST_SERVICE_NAME} is unavailable; install and enable @cningan/dsh-session-status first`);
      return;
    }

    // 语言跟随 DSH 界面设置（与主插件同一套接线：注册字典 + 绑定 t），注册经 ctx.effect 释放。
    ctx.effect(() => ctx.locale.register(LOCALE_NAMESPACE, dictionaries), `${PLUGIN_ID}: dictionaries`);
    const t = ctx.locale.bind(LOCALE_NAMESPACE);

    ctx.effect(() => installPanelStyle(PLUGIN_ID), `${PLUGIN_ID}: stylesheet`);

    const Panel = createDebugPanel({ h, useEffect, useState });
    // 与主插件同款用法：设置页 section（`settings.section`），不是常规设置页的一行。
    // 注入给面板的协作者只有服务与 t。
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: PLUGIN_ID,
      order: PANEL_SECTION_ORDER,
      label: () => t("panelLabel"),
      inject: () => ({ service, t })
    }, Panel));
  }

  return { apply, inject };
}
