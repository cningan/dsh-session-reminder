/**
 * **产物直测**：把真正构建出来的 `dev/debug-panel/lib/client.js` 装进最小假浏览器
 * （`vm` + `window.__ModuleLoader__.load`），断言它是 loader 能加载的 bundle，并且装上之后
 * 真的能在设置页挂出面板、经注入的测试服务完成前台抑制的**双向**验证。
 *
 * 这一条同时是「bundle 可加载」的实测：`pretest` 先跑构建，测试针对产物运行，所以断言的是
 * 产物本身，而不是源码模块。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { PLUGIN_ID, inject as sourceInject } from "../src/plugin.mjs";
import { createFakeContext, createFakeService, createReactRuntime } from "./harness.mjs";

// `pretest` 先构建产物，测试针对它运行。
const bundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

/** 最小假浏览器：只提供 bundle 真正用到的全局量。 */
function launch(source, reactModule) {
  let loaded;
  let plugin;

  const window = {
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    __ModuleLoader__: {
      load(input) {
        loaded = input;
        plugin = input.factory((name) => {
          assert.equal(name, "react");
          return reactModule;
        });
      }
    }
  };
  const document = {
    head: null,
    visibilityState: "visible",
    querySelector: () => null,
    addEventListener() {},
    removeEventListener() {}
  };

  vm.runInNewContext(source, {
    window,
    document,
    navigator: { language: "zh" },
    console: { log() {}, info() {}, warn() {}, error() {} },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {}
  }, { filename: "client.js" });

  return { loaded, plugin };
}

test("loader 契约：__ModuleLoader__.load 拿到 id 与能跑出插件表面的 factory", () => {
  const runtime = createReactRuntime();
  const { loaded, plugin } = launch(bundle, runtime.react);

  assert.notEqual(loaded, undefined, "bundle 应注册到 window.__ModuleLoader__.load");
  assert.equal(loaded.id, PLUGIN_ID);
  assert.equal(loaded.id, "@cningan/dsh-session-status-debug");
  assert.equal(typeof loaded.factory, "function");

  // 真正的 ESM 模块表面：只有 apply 与 inject，没有 CommonJS 拟态残留。
  assert.deepEqual(Object.keys(plugin), ["apply", "inject"]);
  assert.equal(typeof plugin.apply, "function");
  assert.deepEqual([...plugin.inject], sourceInject);
  assert.deepEqual([...plugin.inject], ["sessionStatusTest", "slots", "locale"]);
  assert.equal(typeof plugin.require, "undefined");
  assert.equal(typeof plugin.module, "undefined");
  assert.equal(typeof plugin.exports, "undefined");
});

test("产物装上之后能在 settings.section 挂出面板，并双向验证前台抑制", () => {
  const runtime = createReactRuntime();
  const { plugin } = launch(bundle, runtime.react);
  // 宿主说「页面在前台」（默认状态）：这正是用户默认看到的样子。
  const service = createFakeService({ page: { visibility: "visible", focused: true, background: false } });
  const { ctx, registered } = createFakeContext({ service });

  plugin.apply(ctx);
  assert.equal(registered.slotName, "settings.section");
  assert.equal(registered.slot.meta.id, PLUGIN_ID);

  const props = registered.slot.meta.inject();
  assert.deepEqual(Object.keys(props).sort(), ["service", "t"]);
  assert.equal(props.service, service);

  const panel = runtime.startComponent(registered.slot.render, props);
  assert.deepEqual(
    panel.findAll((node) => typeof node.props?.["data-row"] === "string").map((node) => node.props["data-row"]),
    ["status", "edge", "deliver", "page"]
  );

  // 方向一：强制前台 + 探针 → 不弹（服务没投出去），面板提示被抑制。
  panel.clickAttr("data-mode", "foreground");
  panel.clickAttr("data-probe", "test");
  assert.deepEqual(service.calls.setForegroundOverride, ["foreground"]);
  assert.deepEqual(service.calls.deliverAdHoc, ["test"]);
  assert.equal(service.getSnapshot().page.background, false);
  assert.match(panel.text(), /未弹出：测试提醒 被前台抑制/);

  // 方向二：强制失焦 + 探针 → 弹。
  panel.clickAttr("data-mode", "background");
  panel.clickAttr("data-probe", "test");
  assert.equal(service.getSnapshot().page.background, true);
  assert.match(panel.text(), /已弹出：测试提醒 真的投出了一条提醒/);
  assert.deepEqual(service.calls.deliverAdHoc, ["test", "test"]);
});

test("产物自带面板标识与样式、依赖测试服务，且是自包含的 loader bundle", () => {
  assert.equal(bundle.startsWith("/* Built by dev/debug-panel/scripts/build-client.mjs"), true);
  assert.equal(bundle.includes("sessionStatusTest"), true);
  assert.equal(bundle.includes(PLUGIN_ID), true);
  assert.equal(bundle.includes("dshss-dev-panel"), true);
  assert.equal(bundle.includes(".dshss-dev-mode.is-active"), true);
  // 自包含：没有对源码目录的运行时引用（源码只参与打构建）。
  assert.equal(bundle.includes("import("), false);
  assert.equal(bundle.includes("__DEBUG__"), false, "面板没有构建分支，不需要构建期常量");
});
