/**
 * 插件表面与接线直测（假 ctx，不模拟浏览器）：
 *
 *   1. **依赖清单单一来源**：`inject` 与 `package.json` 的 `dsh.client.inject` 都由
 *      `DEPENDENCIES` 派生、两处一致，且都点名主插件包（`sessionStatusTest` 的提供方——
 *      这个包名只用于**排序激活**，不 import）。任一处单方面增删都会让测试失败。
 *   2. **插件表面**：`createPlugin` 只交出 `apply` + `inject`（没有 CommonJS 拟态残留）。
 *   3. **接线**：字典注册给官方 locale（命名空间独立、中英两份都在）、样式表按 effect 安装、
 *      slot 注册在 `settings.section` 且 id/order/label 明确写着开发用。
 *   4. **端到端（假 ctx → 真面板组件）**：`inject()` 交出的 props 渲染出 4 行诊断与三态开关、
 *      探针按钮，点探针真的打到服务上。
 *   5. **服务缺失时不注册面板**：留下一条线索，而不是挂一个没数据的面板。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEPENDENCIES,
  PANEL_SECTION_ORDER,
  PLUGIN_ID,
  TEST_SERVICE_NAME,
  createPlugin,
  inject
} from "../src/plugin.mjs";
import { LOCALE_NAMESPACE, dictionaries } from "../src/strings.mjs";
import { createFakeContext, createFakeService, createReactRuntime, textOf } from "./harness.mjs";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

/** 造插件（React 来自一个真实可用的最小 hooks runtime，便于后面直接渲染）。 */
function build() {
  const runtime = createReactRuntime();
  const plugin = createPlugin((name) => {
    assert.equal(name, "react", "面板只从 loader 取 react");
    return runtime.react;
  });
  return { plugin, runtime };
}

test("inject 与 package.json 的 dsh.client.inject 由同一张依赖表派生、两处名单一致", () => {
  assert.ok(Array.isArray(manifest.dsh?.client?.inject), "package.json 应声明 dsh.client.inject");
  assert.equal(manifest.name, PLUGIN_ID);
  assert.equal(manifest.dsh.client.platform, "web");

  for (const entry of DEPENDENCIES) {
    assert.equal(typeof entry.service, "string", "依赖表的每一项都要有服务名");
    assert.match(entry.provider, /^@[^/]+\/.+/, `服务 ${entry.service} 的提供方应是包名`);
  }
  assert.deepEqual(inject, DEPENDENCIES.map(({ service }) => service));
  assert.deepEqual([...new Set(inject)], inject, "inject 不应有重复的服务名");

  const providers = [...new Set(DEPENDENCIES.map(({ provider }) => provider))];
  assert.deepEqual(providers, manifest.dsh.client.inject);

  // 测试服务由主插件提供：排序激活必须点名主插件包，否则面板可能在服务注册前被激活。
  assert.equal(TEST_SERVICE_NAME, "sessionStatusTest");
  assert.equal(inject.includes(TEST_SERVICE_NAME), true);
  assert.equal(manifest.dsh.client.inject.includes("@cningan/dsh-session-status"), true);
});

test("插件表面只有 apply + inject，且 inject 就是依赖表派生出来的那份名单", () => {
  const { plugin } = build();

  assert.deepEqual(Object.keys(plugin), ["apply", "inject"]);
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual([...plugin.inject], inject);
  assert.equal(typeof plugin.require, "undefined");
  assert.equal(typeof plugin.module, "undefined");
  assert.equal(typeof plugin.exports, "undefined");
});

test("接线：字典注册、样式表 effect、slot 注册在 settings.section 且写明开发用", () => {
  const { plugin, runtime } = build();
  const service = createFakeService();
  const { ctx, registered } = createFakeContext({ service });

  plugin.apply(ctx);

  assert.equal(registered.namespace, LOCALE_NAMESPACE);
  assert.notEqual(LOCALE_NAMESPACE, "dsh-session-status-notifications");
  assert.deepEqual(registered.tables, dictionaries);
  // 两条 effect：字典注册 + 样式表；两条都有释放函数。
  assert.equal(registered.effects, 2);
  assert.equal(registered.disposers.length, 2);

  assert.equal(registered.slotName, "settings.section");
  const { meta } = registered.slot;
  assert.equal(meta.name, "settings.section");
  assert.equal(meta.id, PLUGIN_ID);
  assert.equal(meta.order, PANEL_SECTION_ORDER);
  assert.equal(meta.order, 31, "紧跟在主插件的 section 之后（order 30）");
  assert.match(meta.label(), /DEV/);
  assert.match(meta.label(), /调试面板/);

  // 面板拿到的协作者只有服务与 t（设置区/装配层的其它东西都不泄漏进面板）。
  const props = meta.inject();
  assert.deepEqual(Object.keys(props).sort(), ["service", "t"]);
  assert.equal(props.service, service);

  // 端到端：真面板组件 + 假服务 → 4 行诊断、三态开关、探针按钮、探针真的落到服务上。
  const panel = runtime.startComponent(registered.slot.render, props);
  const rows = panel.findAll((node) => typeof node.props?.["data-row"] === "string");
  assert.deepEqual(rows.map((node) => node.props["data-row"]), ["status", "edge", "deliver", "page"]);
  assert.deepEqual(
    panel.findAll((node) => typeof node.props?.["data-mode"] === "string").map((node) => node.props["data-mode"]),
    ["auto", "foreground", "background"]
  );
  assert.deepEqual(
    panel.findAll((node) => typeof node.props?.["data-probe"] === "string").map((node) => node.props["data-probe"]),
    ["test", "interrupted", "burst"]
  );
  assert.match(textOf(panel.tree()), /开发调试面板/);

  panel.clickAttr("data-mode", "foreground");
  panel.clickAttr("data-probe", "test");
  assert.deepEqual(service.calls.setForegroundOverride, ["foreground"]);
  assert.deepEqual(service.calls.deliverAdHoc, ["test"]);
  assert.match(textOf(panel.tree()), /未弹出：测试提醒 被前台抑制/);
});

test("测试服务不可用时不注册面板，只留下一条线索", () => {
  const { plugin } = build();
  const { ctx, registered } = createFakeContext({});

  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    plugin.apply(ctx);
  } finally {
    console.error = original;
  }

  assert.equal(registered.slot, null);
  assert.equal(registered.effects, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /sessionStatusTest/);
  assert.match(errors[0], /@cningan\/dsh-session-status/);
});
