/**
 * **产物表面直测**：把真正的产物（`lib/client.js`，DSH loader bundle）装进最小假浏览器，
 * 断言插件对外暴露的两张面，以及测试服务在这条真实投递链路上的行为。
 *
 *   1. **model 面**：`Object.keys(model)` 就是设置区与装配层共同消费的那几个方法；
 *   2. **服务面**：插件经 `ctx.provide("sessionStatusTest", ...)` 注册测试服务，且服务只
 *      交出契约约定的四个方法（`requestPermission` / `sendTestNotification` 属设置区，
 *      不泄漏到 Hook 面上）；
 *   3. **前台覆盖三态**：`auto` 与宿主事实一致；`foreground` 强制抑制；`background`
 *      强制放行——两个方向都能验证「仅前台之外才投递」这条承重规则；
 *   4. **临时投递共用投递路径**：`deliverAdHoc` 与自动提醒、设置页自检共用同一个投递实例
 *      与同一个键序号计数器，因此同样服从前台抑制，键与既有 JSONL 逐字节一致；
 *   5. **订阅/退订**：状态变化（覆盖、投递）通知一次，退订后不再通知；
 *   6. **诊断契约**：真实产物造出的每条上报都过 Host 的闸门，且标注产生它的构建；
 *      覆盖的影响在上报里看得见（`background` 与渠道跟着覆盖走）。
 *
 * 这些断言的对象是**产物**（不是源码模块）：调试 UI 已移出主插件（ADR-0003），所以这里
 * 不再有「正式/调试双构建」的比较——只有一种构建，它的表面必须稳定。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { CLIENT_BUILDS, validateRecord } from "../lib/diagnostics-contract.mjs";
import { TEST_SERVICE_NAME } from "../lib/client/test-service.mjs";

// `pretest` 先构建产物，测试针对它运行（构建脚本只有一种产物）。
const clientBundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

/** model 的公开面：设置区（权限/自检）与测试服务（收敛后的四个方法）都由它派生。 */
const PUBLIC_KEYS = ["getSnapshot", "subscribe", "requestPermission", "sendTestNotification", "setForegroundOverride", "deliverAdHoc"];
/** 测试服务的面：契约约定的四个方法，一个不多。 */
const SERVICE_KEYS = ["setForegroundOverride", "getSnapshot", "subscribe", "deliverAdHoc"];
/** 产物里不得出现的调试痕迹（与 scripts/check-production-bundle.mjs 同一张表的代码部分）。 */
const DEBUG_MARKERS = ["诊断·", "sendProbe", "setTestMode", "dshss-settings-diagnostics", "dshss-settings-tools"];
/** 产物里必须出现的 Hook 特征（阳性对照）。 */
const HOOK_MARKERS = ["sessionStatusTest", "setForegroundOverride", "deliverAdHoc"];

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

/** 最小假浏览器：官方源的替身 + 假 React + 假 fetch（上报请求体原样收下）+ 假 provide。 */
function launch(source, { focused = false } = {}) {
  const reports = [];
  const notices = [];
  const provided = {};

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
    sessions: { list, binding: () => void 0, open() {} },
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
    // Cordis 的服务注册面（`ctx.provide(name, value)`，官方 locale 服务同款用法）。
    provide(name, value) {
      provided[name] = value;
      return () => { delete provided[name]; };
    },
    slots: {
      inject(_slot, callback) { callback(); return () => {}; },
      register(meta, render) { registration = { meta, render }; return () => {}; }
    }
  };

  vm.runInNewContext(source, {
    window,
    document,
    navigator: { language: "en", userActivation: { isActive: false, hasBeenActive: false } },
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
  const model = settingsProps.model;
  const service = provided[TEST_SERVICE_NAME];
  return {
    model,
    service,
    provided,
    settingsProps,
    renderSettings: () => registration.render(settingsProps),
    registration,
    reports,
    notices,
    records: () => reports.map((report) => JSON.parse(report.body)),
    payloads: (event) => reports
      .map((report) => JSON.parse(report.body))
      .filter((record) => record.event === event)
      .map((record) => record.payload),
    /** 触发一次「运行 → 停止」边沿（自动提醒的触发条件）。 */
    stop: () => {
      sessionStatus.set(new Map([["current", { running: true, completionUnread: false }]]));
      sessionStatus.set(new Map([["current", { running: false, completionUnread: false }]]));
    }
  };
}

test("model 与测试服务的键集合固定且互不越界", () => {
  const harness = launch(clientBundle);

  assert.deepEqual(Object.keys(harness.model), PUBLIC_KEYS);
  assert.deepEqual(Object.keys(harness.settingsProps).sort(), ["model", "t"]);
  // 服务只交出契约的四个方法：设置区协作者不泄漏到 Hook 面上。
  assert.deepEqual(Object.keys(harness.service), SERVICE_KEYS);
  for (const key of ["requestPermission", "sendTestNotification"]) {
    assert.equal(Object.hasOwn(harness.service, key), false, `服务不应暴露 ${key}`);
  }
});

test("插件经 ctx.provide 注册测试服务，服务随插件 fiber 释放", () => {
  const harness = launch(clientBundle);

  assert.deepEqual(Object.keys(harness.provided), [TEST_SERVICE_NAME]);
  assert.equal(TEST_SERVICE_NAME, "sessionStatusTest");
  assert.equal(typeof harness.service.setForegroundOverride, "function");
  assert.equal(typeof harness.service.getSnapshot, "function");
  assert.equal(typeof harness.service.subscribe, "function");
  assert.equal(typeof harness.service.deliverAdHoc, "function");
});

test("设置区只留正常使用者那一行（说明 + 状态/自检），没有调试 UI 的痕迹", () => {
  const harness = launch(clientBundle);
  const tree = harness.renderSettings();

  assert.equal(tree.props.className, "dshss-settings");
  // 唯一的一行：说明 + 状态/自检；没有诊断块与工具行的位置。
  assert.equal(tree.props.children.length, 1);
  assert.equal(tree.props.children[0].props.className, "dshss-settings-row");

  const walk = (node, out = []) => {
    if (node === null || typeof node !== "object") return out;
    if (typeof node.props?.className === "string") out.push(node.props.className);
    const children = node.props?.children;
    if (Array.isArray(children)) for (const child of children) walk(child, out);
    return out;
  };
  const classes = walk(tree);
  assert.ok(!classes.includes("dshss-settings-diagnostics"));
  assert.ok(!classes.includes("dshss-settings-tools"));
  assert.ok(classes.includes("dshss-settings-description"));
});

test("产物没有调试痕迹，但带着测试服务 Hook（阳性对照）", () => {
  assert.equal(clientBundle.includes("sessionStatusTest"), true);
  for (const marker of DEBUG_MARKERS) {
    assert.equal(clientBundle.includes(marker), false, `产物不应包含调试痕迹 ${marker}`);
  }
  for (const marker of HOOK_MARKERS) {
    assert.equal(clientBundle.includes(marker), true, `产物应保留 Hook 特征 ${marker}`);
  }
});

test("前台覆盖三态：auto 跟随宿主、foreground 强制抑制、background 强制放行", () => {
  // 宿主说「页面在前台」（聚焦且可见）：auto 与 foreground 都该抑制。
  const foreground = launch(clientBundle, { focused: true });
  assert.equal(foreground.service.getSnapshot().page.background, false);

  foreground.stop();
  assert.equal(foreground.notices.length, 0);
  assert.equal(foreground.payloads("deliver").at(-1).channel, "suppressed-foreground");

  assert.equal(foreground.service.setForegroundOverride("foreground"), "foreground");
  assert.equal(foreground.service.getSnapshot().foregroundOverride, "foreground");
  // 覆盖只替换结论，不改写证据：可见性/焦点仍是宿主原值。
  assert.deepEqual(
    { visibility: foreground.service.getSnapshot().page.visibility, focused: foreground.service.getSnapshot().page.focused },
    { visibility: "visible", focused: true }
  );
  foreground.stop();
  assert.equal(foreground.notices.length, 0);
  assert.equal(foreground.payloads("deliver").at(-1).channel, "suppressed-foreground");

  assert.equal(foreground.service.setForegroundOverride("background"), "background");
  assert.equal(foreground.service.getSnapshot().page.background, true);
  foreground.stop();
  assert.equal(foreground.notices.length, 1);
  const delivered = foreground.payloads("deliver").at(-1);
  assert.equal(delivered.channel, "browser");
  assert.equal(delivered.delivered, true);
  // 覆盖的影响在上报里看得见：这一条不是「按设计静默」，而是真的投了出去。
  assert.equal(delivered.background, true);

  // 反向：宿主说「页面在后台」（失焦）时，foreground 覆盖能强制抑制——两个方向都可验证。
  const background = launch(clientBundle, { focused: false });
  assert.equal(background.service.getSnapshot().page.background, true);
  assert.equal(background.service.setForegroundOverride("foreground"), "foreground");
  assert.equal(background.service.getSnapshot().page.background, false);
  background.stop();
  assert.equal(background.notices.length, 0);
  assert.equal(background.payloads("deliver").at(-1).channel, "suppressed-foreground");

  // 回到 auto：判定回到宿主事实，行为与从未覆盖过一致。
  assert.equal(background.service.setForegroundOverride("auto"), "auto");
  assert.equal(background.service.getSnapshot().page.background, true);
  background.stop();
  assert.equal(background.notices.length, 1);
});

test("setForegroundOverride 的闸门：只认三态，其余一律按 auto", () => {
  const harness = launch(clientBundle, { focused: true });

  assert.equal(harness.service.setForegroundOverride("background"), "background");
  assert.equal(harness.service.setForegroundOverride("FOREGROUND"), "auto");
  assert.equal(harness.service.getSnapshot().foregroundOverride, "auto");
  assert.equal(harness.service.setForegroundOverride(undefined), "auto");
  assert.equal(harness.service.setForegroundOverride(1), "auto");
  assert.equal(harness.service.setForegroundOverride(null), "auto");
  assert.equal(harness.service.setForegroundOverride("auto"), "auto");
});

test("deliverAdHoc 与自动提醒/设置页自检共用同一个投递路径与键序号计数器", () => {
  const harness = launch(clientBundle, { focused: false });

  // 后台：临时投递照常到达，键形与既有 JSONL 一致（前缀 + kind + 序号）。
  assert.equal(harness.service.deliverAdHoc("test"), true);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "DSH reminder test");
  assert.equal(harness.payloads("deliver")[0].key, "test-probe:test:1");

  // 缺省 kind 是 test；`interrupted` 对照自动提醒的那一类参数。
  assert.equal(harness.service.deliverAdHoc(), true);
  assert.equal(harness.service.deliverAdHoc("interrupted"), true);
  assert.equal(harness.payloads("deliver")[1].key, "test-probe:test:2");
  assert.equal(harness.payloads("deliver")[2].key, "test-probe:interrupted:3");
  assert.equal(harness.payloads("deliver")[2].kind, "interrupted");
  assert.equal(harness.notices[2].title, "Session interrupted or stopped");

  // 序号与设置页自检共用同一个计数器（与旧实现逐字节一致）：自检接着拿 4。
  assert.equal(harness.model.sendTestNotification(), true);
  assert.equal(harness.payloads("deliver")[3].key, "test:4");
  // 与自动提醒共用同一个 delivery 实例（tag/权限/上报都在这一条链上）。
  const delivery = harness.payloads("deliver")[3];
  assert.equal(delivery.channel, "browser");
  assert.equal(delivery.browserPermission, "granted");
  assert.equal(delivery.nativeBridge, false);
});

test("deliverAdHoc 服从前台抑制：抑制时返回 false，但仍留下可区分的投递记录", () => {
  const harness = launch(clientBundle, { focused: true });

  assert.equal(harness.service.deliverAdHoc("test"), false);
  assert.equal(harness.notices.length, 0);
  const suppressed = harness.payloads("deliver").at(-1);
  assert.equal(suppressed.channel, "suppressed-foreground");
  assert.equal(suppressed.delivered, false);
  assert.equal(suppressed.background, false);

  // 覆盖成失焦之后同一个调用就投得出去（面板据此做双向验证）。
  harness.service.setForegroundOverride("background");
  assert.equal(harness.service.deliverAdHoc("test"), true);
  assert.equal(harness.notices.length, 1);
});

test("subscribe：状态变化通知一次，退订后不再通知", () => {
  const harness = launch(clientBundle, { focused: true });
  const calls = [];
  const off = harness.service.subscribe(() => calls.push(harness.service.getSnapshot().foregroundOverride));

  harness.service.setForegroundOverride("background");
  assert.deepEqual(calls, ["background"]);
  // 同一个值重复写：状态没变化，不重复通知。
  harness.service.setForegroundOverride("background");
  assert.deepEqual(calls, ["background"]);

  harness.service.deliverAdHoc("test");
  assert.equal(calls.length, 2);

  off();
  harness.service.setForegroundOverride("auto");
  harness.service.deliverAdHoc("test");
  assert.equal(calls.length, 2);

  // 退订是幂等的（重复调用不抛）。
  off();
});

test("真实产物的每条上报都满足诊断契约，且自带产生它的构建", () => {
  const harness = launch(clientBundle, { focused: true });
  harness.service.setForegroundOverride("background");
  harness.service.deliverAdHoc("test");
  harness.stop();

  const records = harness.records();
  assert.ok(records.length > 0, "装载快照与状态摘要应各落一条");
  for (const record of records) {
    const verdict = validateRecord(record);
    assert.equal(verdict.ok, true, `${record.event} 记录应满足契约：${verdict.reason ?? ""}`);
  }
  // 只有一种构建：记录仍标注自己是哪台仪器（旧的 `debug` 取值留给历史记录）。
  assert.deepEqual([...new Set(records.map((record) => record.build))], [CLIENT_BUILDS.PRODUCTION]);
});
