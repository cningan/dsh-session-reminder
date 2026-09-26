/**
 * **model 表面一致性**直测（本票验收核心）：同一份源码，在内存里各打一次**正式**与
 * **调试** bundle（esbuild `write: false`，不动仓库里的 `lib/client.js`），装进同一套最小
 * 假浏览器，断言：
 *
 *   1. 两种构建下 `Object.keys(model)` **完全相同**，且与调试键无交集——「一个是否存在
 *      取决于编译期常量的表面不是 interface」（issue #4 的走查意见）；
 *   2. 调试能力只经**显式注入**可达：正式构建不构造 `debugTools`（设置区拿到 null），
 *      调试构建构造它，探针的键与自检共用同一个计数器（逐字节不变）；
 *   3. 正式产物里没有调试能力、调试产物里有（阳性对照，防止断言退化成永真）；
 *   4. 前台否决与测试模式：正式构建恒按前台规则抑制，调试构建里注入的测试模式开关
 *      仍能覆盖它；两种构建都报告 `testMode` 这一位（正式恒为 false）。
 */
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

import { build } from "esbuild";

import { CLIENT_BUILDS, validateRecord } from "../lib/diagnostics-contract.mjs";

const ENTRY = fileURLToPath(new URL("../lib/client/entry.mjs", import.meta.url));

/** model 的公开面：两种构建都必须一字不差。 */
const PUBLIC_KEYS = ["getSnapshot", "subscribe", "requestPermission", "sendTestNotification"];
/** 调试键：不得出现在 model 上（它们是注入的 `client/debug-tools` 的方法）。 */
const DEBUG_KEYS = ["sendProbe", "sendProbeBurst", "sendDelayedProbe", "setTestMode"];
/** 正式产物里不得出现的调试特征（与 scripts/check-production-bundle.mjs 同一张表）。 */
const DEBUG_MARKERS = ["当前会话在状态", "sendProbe", "setTestMode", "test-probe"];

async function bundleOf(debug) {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    charset: "utf8",
    legalComments: "none",
    minify: !debug,
    write: false,
    define: { __DEBUG__: debug ? "true" : "false" }
  });
  return result.outputFiles[0].text;
}

const productionBundle = await bundleOf(false);
const debugBundle = await bundleOf(true);

function observable(initial) {
  let value = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      value = next;
      for (const listener of [...listeners]) listener();
    }
  };
}

/** 最小假浏览器：官方源的替身 + 假 React + 假 fetch（上报请求体原样收下）。 */
function launch(source, { focused = false } = {}) {
  const reports = [];
  const notices = [];
  const opened = [];

  class MockNotification {
    static permission = "granted";
    static async requestPermission() { return "granted"; }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notices.push(this);
    }
    close() {}
  }

  const window = {
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    __ModuleLoader__: {
      load({ factory }) {
        const React = {
          createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
          useEffect() {},
          useState: (value) => [value, () => {}]
        };
        window.plugin = factory((name) => {
          assert.equal(name, "react");
          return React;
        });
      }
    }
  };

  const document = {
    visibilityState: "visible",
    documentElement: { lang: "en" },
    head: null,
    hasFocus: () => focused,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null
  };

  const list = observable({ byId: { current: { title: "Current session" } } });
  const sessionStatus = observable(new Map([["current", { running: false, completionUnread: false }]]));
  const current = observable({ key: "current" });
  const connection = observable("connected");

  let registered;
  const translate = (key, params) => {
    const table = registered?.["en"] ?? {};
    const template = typeof table[key] === "string" ? table[key] : key;
    if (params === void 0) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };

  let registration;
  const ctx = {
    sessions: { list, binding: () => void 0, open: (id) => opened.push(id) },
    uiSession: { sessionStatus, adapter: { current } },
    connection: { state: connection },
    locale: {
      register(_namespace, table) { registered = table; return () => {}; },
      bind() { return translate; }
    },
    effect(effect) {
      const dispose = effect();
      return typeof dispose === "function" ? dispose : () => {};
    },
    slots: {
      inject(_slot, callback) { callback(); return () => {}; },
      register(meta, render) { registration = { meta, render }; return () => {}; }
    }
  };

  vm.runInNewContext(source, {
    window,
    document,
    navigator: { language: "en" },
    Notification: MockNotification,
    Map,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    fetch: (path, options) => {
      reports.push({ path, body: options?.body });
      return Promise.resolve({ ok: true });
    },
    console: { log() {}, info() {}, warn() {}, error() {} }
  }, { filename: "client.js" });
  window.plugin.apply(ctx);

  const settingsProps = registration.meta.inject();
  return {
    model: settingsProps.model,
    debugTools: settingsProps.debugTools,
    settingsProps,
    renderSettings: () => registration.render(settingsProps),
    registration,
    reports,
    notices,
    opened,
    setStatuses: (next) => sessionStatus.set(next)
  };
}

function payloads(launchResult, event) {
  return launchResult.reports
    .map((report) => JSON.parse(report.body))
    .filter((record) => record.event === event)
    .map((record) => record.payload);
}

test("正式构建与调试构建下 model 的键集合完全相同，且与调试键无交集", () => {
  const production = launch(productionBundle);
  const debug = launch(debugBundle);

  assert.deepEqual(Object.keys(production.model), PUBLIC_KEYS);
  assert.deepEqual(Object.keys(debug.model), PUBLIC_KEYS);
  assert.deepEqual(Object.keys(debug.model), Object.keys(production.model));

  for (const key of DEBUG_KEYS) {
    assert.equal(Object.hasOwn(production.model, key), false, `正式构建的 model 不应有 ${key}`);
    assert.equal(Object.hasOwn(debug.model, key), false, `调试构建的 model 也不应有 ${key}（调试能力是注入的）`);
  }
});

test("调试能力只经显式注入可达：正式构建不构造它，调试构建构造它并交给设置区", () => {
  const production = launch(productionBundle);
  const debug = launch(debugBundle);

  assert.equal(production.debugTools, null);
  assert.equal(production.settingsProps.debugTools, null);
  assert.ok(debug.debugTools !== null);
  for (const key of DEBUG_KEYS) {
    assert.equal(typeof debug.debugTools[key], "function", `调试工具应提供 ${key}`);
  }
  assert.equal(debug.settingsProps.debugTools, debug.debugTools);
});

test("设置区元素树同形：正式构建只留两个空位，调试构建在那里给出诊断块与工具行", () => {
  const production = launch(productionBundle);
  const debug = launch(debugBundle);
  const productionTree = production.renderSettings();
  const debugTree = debug.renderSettings();

  assert.equal(productionTree.props.children.length, 3);
  assert.equal(debugTree.props.children.length, 3);
  assert.equal(productionTree.props.children[1], null);
  assert.equal(productionTree.props.children[2], null);
  assert.equal(debugTree.props.children[1].props.className, "dshss-settings-diagnostics");
  assert.equal(debugTree.props.children[2].props.className, "dshss-settings-tools");
});

test("正式产物没有调试能力，调试产物有（阳性对照）", () => {
  for (const marker of DEBUG_MARKERS) {
    assert.equal(productionBundle.includes(marker), false, `正式产物不应包含 ${marker}`);
    assert.equal(debugBundle.includes(marker), true, `调试产物应保留 ${marker}`);
  }
});

test("探针的键与设置页自检共用同一个计数器（逐字节不变）", () => {
  const debug = launch(debugBundle);

  assert.equal(debug.debugTools.sendProbe("test"), true);
  assert.equal(debug.model.sendTestNotification(), true);

  const deliveries = payloads(debug, "deliver");
  assert.equal(deliveries[0].key, "test-probe:test:1");
  assert.equal(deliveries[0].kind, "test");
  assert.equal(deliveries[1].key, "test:2");
  // 探针的载荷与自检同源（文案来自官方 locale 字典）。
  assert.equal(debug.notices[0].title, "DSH reminder test");
});

test("前台否决：正式构建恒按前台规则抑制，调试构建里注入的测试模式开关能覆盖它", () => {
  const production = launch(productionBundle, { focused: true });
  const debug = launch(debugBundle, { focused: true });

  const stop = (harness) => {
    harness.setStatuses(new Map([["current", { running: true, completionUnread: false }]]));
    harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));
  };

  stop(production);
  assert.equal(production.notices.length, 0);
  assert.equal(payloads(production, "deliver").at(-1).channel, "suppressed-foreground");
  // 两种构建都报告这一位；正式构建下没有任何注入方，恒为 false。
  assert.equal(production.model.getSnapshot().testMode, false);

  assert.equal(debug.model.getSnapshot().testMode, false);
  stop(debug);
  assert.equal(debug.notices.length, 0);

  debug.debugTools.setTestMode(true);
  assert.equal(debug.model.getSnapshot().testMode, true);
  stop(debug);
  assert.equal(debug.notices.length, 1);
  assert.equal(payloads(debug, "deliver").at(-1).delivered, true);
});

test("真实产物的每条上报都满足诊断契约，且自带产生它的构建", () => {
  const production = launch(productionBundle);
  const debug = launch(debugBundle);
  const recordsOf = (launchResult) => launchResult.reports.map((report) => JSON.parse(report.body));

  const productionRecords = recordsOf(production);
  const debugRecords = recordsOf(debug);
  assert.ok(productionRecords.length > 0, "装载快照与状态摘要应各落一条");

  // 发送方与校验方就同一份契约达成一致：真实产物造出的记录一条都不该被 Host 的闸门拒掉。
  for (const [label, records, expected] of [
    ["正式", productionRecords, CLIENT_BUILDS.PRODUCTION],
    ["调试", debugRecords, CLIENT_BUILDS.DEBUG]
  ]) {
    for (const record of records) {
      const verdict = validateRecord(record);
      assert.equal(verdict.ok, true, `${label}构建的 ${record.event} 记录应满足契约：${verdict.reason ?? ""}`);
      assert.equal(record.build, expected, `${label}构建的记录应标注自己是哪台仪器`);
    }
  }

  // 两种构建的观测流除 `at`（时刻）与 `build`（仪器）外逐字节同形：调试能力是注入的，
  // 不往观测流里加东西（SPEC「调试构建下的诊断记录逐字节不变」）。
  const shape = (records) => records.map((record) => JSON.stringify({ ...record, at: null, build: null }));
  assert.deepEqual(shape(debugRecords), shape(productionRecords));
});
