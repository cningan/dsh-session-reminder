/**
 * **产物表面直测**：把真正的产物（`lib/client.js`，DSH loader bundle）装进最小假浏览器，
 * 断言插件对外暴露的那张面（唯一的 Hook），以及测试服务在这条真实投递链路上的行为。
 *
 *   1. **服务面**：插件经 `ctx.provide("sessionStatusTest", ...)` 注册测试服务，且服务只
 *      交出契约约定的四个方法（装配层内部的权限请求 `requestPermission` 不泄漏到 Hook 面上）；
 *      主插件**不含任何设置 UI**，因此也不注册任何 slot；
 *   2. **前台覆盖三态**：`auto` 与宿主事实一致；`foreground` 强制抑制；`background`
 *      强制放行——两个方向都能验证「仅前台之外才投递」这条承重规则；
 *   3. **临时投递共用投递路径**：`deliverAdHoc` 与自动提醒共用同一个投递实例与同一个键
 *      序号计数器，因此同样服从前台抑制，键与既有 JSONL 逐字节一致；
 *   4. **订阅/退订**：状态变化（覆盖、投递）通知一次，退订后不再通知；
 *   5. **诊断契约**：真实产物造出的每条上报都过 Host 的闸门，且标注产生它的构建；
 *      覆盖的影响在上报里看得见（`background` 与渠道跟着覆盖走）。
 *
 * 这些断言的对象是**产物**（不是源码模块）：调试 UI 已移出主插件（ADR-0003），设置界面也
 * 已彻底移除，所以这里不再有「正式/调试双构建」的比较——只有一种构建，它的表面必须稳定。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { CLIENT_BUILDS, validateRecord } from "../lib/diagnostics-contract.mjs";
import { TERMINAL_REASONS } from "../lib/core/classify.mjs";
import { dictionaries, terminalHeadline } from "../lib/core/text.mjs";
import { SAMPLE_REASONS, TEST_SERVICE_NAME } from "../lib/client/test-service.mjs";

// `pretest` 先构建产物，测试针对它运行（构建脚本只有一种产物）。
const clientBundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

/** 测试服务的面：契约约定的四个方法，一个不多。 */
const SERVICE_KEYS = ["setForegroundOverride", "getSnapshot", "subscribe", "deliverAdHoc", "deliverSample", "setDevToolsEnabled"];
/** 产物里不得出现的调试 / 设置界面痕迹（与 scripts/check-production-bundle.mjs 同一张表）。 */
const DEBUG_MARKERS = [
  "诊断·",
  "sendProbe",
  "setTestMode",
  "dshss-settings-diagnostics",
  "dshss-settings-tools",
  "dshss-settings",
  "settings.section"
];
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

/** 最小假浏览器：官方源的替身 + 假 fetch（上报请求体原样收下）+ 假 provide（无 slots）。 */
function launch(source, { focused = false, workspace, eventWindow, backgroundWindows, dshVersion, devTools = false } = {}) {
  const reports = [];
  const notices = [];
  const provided = {};
  const opened = [];
  const serviceCalls = [];

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
        // 插件不含任何 UI：factory 收到 loadModule 但一次都不该调用它。
        window.plugin = factory((name) => {
          throw new Error(`插件不应向 loader 取模块，却要了 ${name}`);
        });
      }
    }
  };

  const document = {
    visibilityState: "visible",
    documentElement: { lang: "en" },
    hasFocus: () => focused,
    addEventListener() {},
    removeEventListener() {}
  };

  // 官方 boot 清单：DSH 版本的事实来源（`__DSH_BOOT__.release.version`）。
  if (dshVersion !== void 0) window.__DSH_BOOT__ = { release: { version: dshVersion } };

  const list = observable({ byId: { current: { title: "Current session" } } });
  const sessionStatus = observable(new Map([["current", { running: false, completionUnread: false }]]));
  const current = observable({ key: "current" });
  const connection = observable("connected");
  // 选中会话的详情面：本文件不关心它，但绑定对象必须交出 getSnapshot/subscribe。
  const sessionFace = observable({});

  let registered;
  const translate = (key, params) => {
    const table = registered?.["en"] ?? {};
    const template = typeof table[key] === "string" ? table[key] : key;
    if (params === void 0) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };

  const ctx = {
    sessions: {
      list,
      // 绑定借出「已保留的会话作用域」：选中会话由 eventWindow 模拟，后台会话由
      // backgroundWindows 逐 id 提供（没有就是 undefined——与官方 scopes.get(id)?.binding 一致）。
      binding: (id) => {
        const perSession = backgroundWindows?.get(id);
        if (perSession !== void 0) return perSession;
        return eventWindow === void 0 ? void 0 : { eventSource: eventWindow, session: sessionFace };
      },
      open() {}
    },
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
    // 可选服务解析：插件用 `ctx.get("uiWorkspace", strict)` 取「打开会话」的入口，
    // 不写进 inject。第二个参数（严格度）被记下来，供测试断言两处调用不同。
    get(name, strict) {
      serviceCalls.push({ name, strict });
      return name === "uiWorkspace" ? workspace : void 0;
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

  const service = provided[TEST_SERVICE_NAME];
  // 调试工具默认关闭：需要测试动作的用例显式打开（默认关闭本身另有直测）。
  if (devTools) service.setDevToolsEnabled(true);
  return {
    service,
    provided,
    reports,
    notices,
    opened,
    eventWindow,
    serviceCalls,
    records: () => reports.map((report) => JSON.parse(report.body)),
    payloads: (event) => reports
      .map((report) => JSON.parse(report.body))
      .filter((record) => record.event === event)
      .map((record) => record.payload),
    /** 只翻运行状态（不触发事件窗口）：用来把一次停止拆成「先跑、再出事件、最后停」。 */
    setRunning: (running) => {
      sessionStatus.set(new Map([["current", { running, completionUnread: false }]]));
    },
    /** 直接写整张会话状态表：用来同时驱动选中会话与后台会话。 */
    setStatuses: (entries) => sessionStatus.set(new Map(entries)),
    /** 直接写列表行：后台会话的标题、归属都来自这里。 */
    setRows: (byId) => list.set({ byId }),
    /** 触发一次「运行 → 停止」边沿（自动提醒的触发条件）。 */
    stop: () => {
      sessionStatus.set(new Map([["current", { running: true, completionUnread: false }]]));
      sessionStatus.set(new Map([["current", { running: false, completionUnread: false }]]));
    }
  };
}

test("测试服务的键集合固定且不越界", () => {
  const harness = launch(clientBundle);

  // 服务只交出契约的四个方法：装配层的内部协作者不泄漏到 Hook 面上。
  assert.deepEqual(Object.keys(harness.service), SERVICE_KEYS);
  for (const key of ["requestPermission", "sendTestNotification", "notify"]) {
    assert.equal(Object.hasOwn(harness.service, key), false, `服务不应暴露 ${key}`);
  }
  // 主插件不含设置 UI：注册面只有测试服务这一项（没有 slot 注册可观察）。
  assert.deepEqual(Object.keys(harness.provided), [TEST_SERVICE_NAME]);
});

test("调试工具默认关闭：测试动作在服务侧就被拒绝，正式使用不受影响", () => {
  const harness = launch(clientBundle, { focused: true });

  assert.equal(harness.service.getSnapshot().devTools.enabled, false, "并回主包后默认必须是关闭的");
  // 关着时三个写入口全部无效：不改事实、不投递、不写记录。
  assert.equal(harness.service.setForegroundOverride("background"), "auto");
  assert.equal(harness.service.deliverAdHoc("test"), false);
  assert.equal(harness.service.deliverSample("completed"), false);
  assert.equal(harness.notices.length, 0);
  assert.equal(harness.payloads("deliver").length, 0, "关着时不应留下任何投递记录");
  assert.equal(harness.service.getSnapshot().page.background, false, "前台判定不应被改动");

  // 打开之后才生效。
  assert.equal(harness.service.setDevToolsEnabled(true), true);
  assert.equal(harness.service.setForegroundOverride("background"), "background");
  assert.equal(harness.service.deliverAdHoc("test"), true);
  assert.equal(harness.notices.length, 1);

  // 再关掉：覆盖随总开关一起复位（避免「关掉了却还在覆盖」）。
  assert.equal(harness.service.setDevToolsEnabled(false), false);
  assert.equal(harness.service.getSnapshot().foregroundOverride, "auto");
  assert.equal(harness.service.deliverAdHoc("test"), false);
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

test("产物没有调试与设置 UI 的痕迹，但带着测试服务 Hook（阳性对照）", () => {
  assert.equal(clientBundle.includes("sessionStatusTest"), true);
  for (const marker of DEBUG_MARKERS) {
    assert.equal(clientBundle.includes(marker), false, `产物不应包含调试/设置痕迹 ${marker}`);
  }
  for (const marker of HOOK_MARKERS) {
    assert.equal(clientBundle.includes(marker), true, `产物应保留 Hook 特征 ${marker}`);
  }
});

test("前台覆盖三态：auto 跟随宿主、foreground 强制抑制、background 强制放行", () => {
  // 宿主说「页面在前台」（聚焦且可见）：auto 与 foreground 都该抑制。
  const foreground = launch(clientBundle, { focused: true, devTools: true });
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
  const background = launch(clientBundle, { focused: false, devTools: true });
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
  const harness = launch(clientBundle, { focused: true, devTools: true });

  assert.equal(harness.service.setForegroundOverride("background"), "background");
  assert.equal(harness.service.setForegroundOverride("FOREGROUND"), "auto");
  assert.equal(harness.service.getSnapshot().foregroundOverride, "auto");
  assert.equal(harness.service.setForegroundOverride(undefined), "auto");
  assert.equal(harness.service.setForegroundOverride(1), "auto");
  assert.equal(harness.service.setForegroundOverride(null), "auto");
  assert.equal(harness.service.setForegroundOverride("auto"), "auto");
});

test("deliverAdHoc 与自动提醒共用同一个投递路径与键序号计数器", () => {
  const harness = launch(clientBundle, { focused: false, devTools: true });

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
  assert.equal(harness.notices[2].title, "Session ended (reason not read)");

  // 自动提醒与临时投递共用同一个 delivery 实例（tag/权限/上报都在这一条链上）：
  // 它接着拿第 4 号序号，且渠道/权限事实与那一条链一致。
  harness.stop();
  const auto = harness.payloads("deliver").at(-1);
  assert.equal(auto.channel, "browser");
  assert.equal(auto.browserPermission, "granted");
  assert.equal(auto.nativeBridge, false);
});

test("deliverAdHoc 服从前台抑制：抑制时返回 false，但仍留下可区分的投递记录", () => {
  const harness = launch(clientBundle, { focused: true, devTools: true });

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

test("deliverSample：按原因模拟，文案与真实停止逐字符相同", () => {
  const harness = launch(clientBundle, { focused: false, devTools: true });
  const t = (key) => dictionaries.en[key];
  const expected = [
    ["completed", "Session run completed", "Sample session"],
    ["interrupted", "Session ended (reason not read)", "Sample session: It ended, but the stop reason was not read"],
    ["process-interrupted", "This run did not finish (DSH exited)", "Sample session"],
    ["blocked", "This run was blocked", "Sample session"],
    ["max-tokens", "This run reached the output limit", "Sample session"],
    ["error", "This run failed", "Sample session: E_MODEL: upstream 502"],
    ["agent-error", "Session runtime error", "Sample session: runtime crashed"],
    ["prompt-error", "Operation failed", "Sample session: E_NET: offline"],
    ["session-open-error", "The session window failed to load", "Sample session: It ended, but the stop reason was not read"],
    ["aborted-parent", "The parent task stopped this run", "Sample session"],
    ["aborted-hook", "An extension stopped this run", "Sample session: policy-check"]
  ];

  // 词表顺序以 core/classify 为准；这张表逐条钉住「标题说为什么停、正文只说标题没说的」。
  assert.deepEqual(expected.map(([reason]) => reason), [...SAMPLE_REASONS]);

  for (const [reason, title, message] of expected) {
    assert.equal(harness.service.deliverSample(reason), true, `${reason} 应投出去`);
    const notice = harness.notices.at(-1);
    assert.equal(notice.title, title, `${reason} 的标题`);
    // Web Notification 的正文走 options.body（delivery 层把 notice.message 映射过去）。
    assert.equal(notice.options.body, message, `${reason} 的正文`);
    // 真实停止用同一个 terminalHeadline：模拟与真实必须是同一句话。
    assert.equal(notice.title, terminalHeadline(reason, t), `${reason} 应与真实停止同源`);
  }

  // 诊断里带着原因（否则「哪条文案」事后无从核对），键前缀沿用探针前缀并标明 sample。
  const payloads = harness.payloads("deliver");
  assert.deepEqual(payloads.map((payload) => payload.reason), expected.map(([reason]) => reason));
  assert.equal(payloads[0].key, "test-probe:sample:completed:1");
  assert.equal(payloads[1].key, "test-probe:sample:interrupted:2");
  // `kind` 只分两类：completed 走已完成的投递分支，其余都是 terminal。
  assert.deepEqual(payloads.map((payload) => payload.kind), expected.map(([reason]) => (reason === "completed" ? "completed" : "interrupted")));

  // 同样服从前台抑制（与自动提醒共用投递路径）。
  const focused = launch(clientBundle, { focused: true, devTools: true });
  assert.equal(focused.service.deliverSample("completed"), false);
  assert.equal(focused.notices.length, 0);
  assert.equal(focused.payloads("deliver").at(-1).channel, "suppressed-foreground");
});

test("subscribe：状态变化通知一次，退订后不再通知", () => {
  const harness = launch(clientBundle, { focused: true, devTools: true });
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
  const harness = launch(clientBundle, { focused: true, dshVersion: "0.2.2-rc.1" });
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

  // 版本事实：装载快照带上 DSH 自身版本，兼容问题因此可事后判断而不是靠猜。
  assert.equal(harness.payloads("attach")[0].dshVersion, "0.2.2-rc.1");
  // 没有 boot 清单时如实报 null，不编一个版本号。
  assert.equal(launch(clientBundle).payloads("attach")[0].dshVersion, null);
});

test("停止原因：DSH 0.2 的 entries 事件窗口能读出 turn/end，文案与上报都跟着原因走", () => {
  const eventWindow = observable({
    entries: [{ type: "append", event: { seq: 3, type: "turn/end", data: { reason: { kind: "completed" } } } }],
    hasMore: false,
    revision: 1,
    change: { kind: "replace", entries: [] }
  });
  const harness = launch(clientBundle, { focused: false, eventWindow });

  // ① 绑定会话时只抬水位：窗口里那条旧 turn/end（completed）不是这一轮的结果。
  harness.stop();
  assert.equal(harness.notices.length, 1, "停止应投递一条提醒");
  assert.equal(harness.notices[0].title, "Session ended (reason not read)");
  assert.match(harness.notices[0].options.body, /stop reason was not read/);
  assert.equal(harness.payloads("deliver").at(-1).reason, "interrupted");

  // ② 这一轮真正的新 turn/end（模型调用出错）到达之后再停：标题说「本轮出错」，
  //    正文带错误码与消息——这正是过去永远只会显示「已中断或停止」的那一类。
  harness.setRunning(true);
  eventWindow.set({
    entries: [
      { type: "append", event: { seq: 3, type: "turn/end", data: { reason: { kind: "completed" } } } },
      { type: "append", event: { seq: 9, type: "turn/end", data: { reason: { kind: "error", error: { code: "E_MODEL", message: "upstream 502" } } } } }
    ],
    hasMore: false,
    revision: 2,
    change: { kind: "append", entries: [] }
  });
  harness.setRunning(false);

  assert.equal(harness.notices.length, 2);
  assert.equal(harness.notices[1].title, "This run failed");
  assert.equal(harness.notices[1].options.body, "Current session: E_MODEL: upstream 502");
  assert.equal(harness.payloads("deliver").at(-1).reason, "error");

  // ③ 正常完成必须说「已完成」，而不是又一条通用中断。
  harness.setRunning(true);
  eventWindow.set({
    entries: [{ type: "append", event: { seq: 12, type: "turn/end", data: { reason: { kind: "completed" } } } }],
    hasMore: false,
    revision: 3,
    change: { kind: "append", entries: [] }
  });
  harness.setRunning(false);

  assert.equal(harness.notices.length, 3);
  assert.equal(harness.notices[2].title, "Session run completed");
  assert.equal(harness.notices[2].options.body, "Current session");
  assert.equal(harness.payloads("deliver").at(-1).reason, "completed");
  assert.equal(harness.payloads("deliver").at(-1).kind, "completed");
});

test("点击通知：优先用官方 uiWorkspace.openSession 打开会话", () => {
  const workspace = { opened: [], openSession(id) { this.opened.push(id); } };
  const harness = launch(clientBundle, { focused: false, workspace });
  harness.stop();

  assert.equal(harness.notices.length, 1);

  // 装载快照如实记下「能不能跳转」这一能力位，且用 **non-strict** 解析：它描述「这套组合里
  // 有没有 ui-workspace」，不是「此刻是否已激活」——本插件的 apply 可能早于它激活。
  assert.equal(harness.payloads("attach")[0].hasWorkspaceOpen, true);
  assert.deepEqual(
    harness.serviceCalls.filter((call) => call.name === "uiWorkspace").map((call) => call.strict),
    [false],
    "装载快照应使用 non-strict 解析"
  );

  harness.notices[0].onclick();
  assert.deepEqual(workspace.opened, ["current"], "点击应调用 uiWorkspace.openSession");
  // 点击那一次用 **strict** 解析：必须真的可用，否则宁可回退。
  assert.deepEqual(
    harness.serviceCalls.filter((call) => call.name === "uiWorkspace").map((call) => call.strict),
    [false, true],
    "装载快照 non-strict、点击 strict"
  );

  // 没有 ui-workspace 时不再调用已不存在的 sessions.open：点一下只是不跳转，不抛错。
  const bare = launch(clientBundle, { focused: false });
  bare.stop();
  assert.equal(bare.payloads("attach")[0].hasWorkspaceOpen, false);
  assert.doesNotThrow(() => bare.notices[0].onclick(), "缺少打开入口时点击通知不应抛错");
});

test("后台会话的停止边沿：binding 还在就用它自己的 turn/end，不再一律「原因未读取」", () => {
  // 这是用户报的那一类：在后台跑完的会话，提醒说「原因未读取」。
  // 事实是它自己的作用域还在（用户在这个窗口里打开过），窗口里有 turn/end（completed）。
  const bgWindow = observable({
    entries: [{ type: "append", event: { seq: 7, type: "turn/end", data: { reason: { kind: "completed" } } } }],
    hasMore: false,
    revision: 1,
    change: { kind: "replace", entries: [] }
  });
  const harness = launch(clientBundle, {
    focused: false,
    backgroundWindows: new Map([["bg", { eventSource: bgWindow, session: observable({}) }]])
  });
  harness.setRows({ current: { title: "Current session" }, bg: { title: "Background session" } });

  // 基线：两个都在跑（首次观察只建基线，不追报）。
  harness.setStatuses([
    ["current", { running: true, completionUnread: false }],
    ["bg", { running: true, completionUnread: false }]
  ]);
  // 后台会话结束。
  harness.setStatuses([
    ["current", { running: true, completionUnread: false }],
    ["bg", { running: false, completionUnread: false }]
  ]);

  const notice = harness.notices.at(-1);
  assert.equal(notice.title, "Session run completed", "后台会话正常结束应报「已完成」");
  assert.equal(notice.options.body, "Background session");
  const delivered = harness.payloads("deliver").at(-1);
  assert.equal(delivered.sessionId, "bg");
  assert.equal(delivered.reason, "completed", "原因来自它自己的事件窗口");
  // 边沿记录也要如实：这一条确实有 turn/end 事实。
  const edge = harness.payloads("edge").find((entry) => entry.sessionId === "bg");
  assert.equal(edge.hasTurnEndReason, true);
});
