/**
 * 投递层直测（`lib/client/delivery.mjs`）：不模拟整个浏览器，只注入最小替身
 * （window 桥、Notification 构造器、注入的 sink）。判定与前台否决都不在这个 module，
 * 因此这里也只覆盖渠道选择、平台事件回灌与通知参数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ADAPTER_RESULTS,
  CHANNEL_IDS,
  createChannelAdapters,
  createDelivery,
  DELIVERY_OUTCOMES,
  hasNativeBridge,
  readBrowserPermission,
  readCapabilities,
  readUserActivation,
  runDeliveryChain
} from "../lib/client/delivery.mjs";

const PLUGIN_ID = "dsh-session-reminder";

function notice(overrides = {}) {
  return {
    key: "terminal:s1:1",
    kind: "terminal",
    sessionId: "s1",
    title: "Session ended (reason not read)",
    message: "Background session",
    ...overrides
  };
}

/** 最小投递替身：桥、Notification 构造器、sink 全部注入，不碰真实 DOM。 */
function createHarness({ windowLike = { focus() {} }, permission = "granted", notification = true, report } = {}) {
  const shellPayloads = [];
  const webviewPayloads = [];
  const reports = [];
  const platforms = [];
  const opened = [];
  const failures = [];
  const notices = [];
  let focusedCount = 0;
  windowLike.focus = () => { focusedCount += 1; };

  class FakeNotification {
    static permission = permission;
    static requests = 0;
    static async requestPermission() {
      FakeNotification.requests += 1;
      return FakeNotification.permission;
    }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      this.closed = false;
      notices.push(this);
    }
    close() { this.closed = true; }
  }

  const delivery = createDelivery({
    window: windowLike,
    notificationCtor: notification ? FakeNotification : null,
    report: report === void 0 ? (event, payload) => reports.push({ event, payload }) : report,
    onPlatform: (feedback) => platforms.push(feedback),
    now: () => new Date("2026-09-26T10:20:30Z"),
    openSession: (sessionId) => opened.push(sessionId),
    onError: (label, error) => failures.push({ label, error })
  });

  return {
    delivery,
    window: windowLike,
    notices,
    shellPayloads,
    webviewPayloads,
    reports,
    platforms,
    opened,
    failures,
    FakeNotification,
    get focusedCount() { return focusedCount; },
    deliveries: () => reports.filter((entry) => entry.event === "deliver").map((entry) => entry.payload),
    platformReports: () => reports.filter((entry) => entry.event === "platform").map((entry) => entry.payload)
  };
}

function throwingBridges(harness) {
  harness.window.dshShell = { notify() { throw new Error("bridge unavailable"); } };
  harness.window.chrome = { webview: { postMessage() { throw new Error("WebView unavailable"); } } };
}

test("falls back to the WebView bridge when the shell bridge throws", () => {
  const harness = createHarness();
  harness.window.dshShell = { notify() { throw new Error("bridge unavailable"); } };
  harness.window.chrome = { webview: { postMessage: (payload) => harness.webviewPayloads.push(payload) } };

  const result = harness.delivery.deliver(notice(), { background: true });

  assert.equal(result.outcome, DELIVERY_OUTCOMES.NATIVE_BRIDGE);
  assert.equal(result.delivered, true);
  // 渠道抛错后回退：结果能区分「回退成功」与「本来就走 WebView」。
  assert.equal(result.fellBack, true);
  assert.deepEqual(result.errors.map((entry) => entry.channel), ["shell"]);
  assert.deepEqual(harness.webviewPayloads, [{
    type: `${PLUGIN_ID}/notify`,
    kind: "terminal",
    title: "Session ended (reason not read)",
    message: "Background session"
  }]);
  // 原生桥被接住时不碰浏览器 API。
  assert.equal(harness.notices.length, 0);
  assert.deepEqual(harness.deliveries(), [{
    key: "terminal:s1:1",
    kind: "terminal",
    // 停止原因随投递落盘（notice 没带就是 null）：文案是否对得上因此可事后审计。
    reason: null,
    sessionId: "s1",
    channel: "native-bridge",
    delivered: true,
    background: true,
    browserPermission: "granted",
    nativeBridge: true,
    userActivation: null
  }]);
});

test("falls back to the browser Notification API when every native bridge throws", () => {
  const harness = createHarness();
  throwingBridges(harness);

  const result = harness.delivery.deliver(notice(), { background: true });

  assert.equal(result.outcome, DELIVERY_OUTCOMES.BROWSER);
  assert.equal(result.channel, "browser");
  assert.equal(result.delivered, true);
  assert.equal(result.fellBack, true);
  assert.deepEqual(result.errors.map((entry) => entry.channel), ["shell", "webview"]);
  // 走到浏览器这一步才读得到权限，调用方据此刷新自己的权限状态。
  assert.equal(result.browserPermission, "granted");
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "Session ended (reason not read)");
  assert.equal(harness.notices[0].options.body, "Background session");
  assert.equal(harness.failures.map((entry) => entry.label).join(" | "),
    "shell notification failed | WebView notification failed");
});

test("does not deliver without a usable channel, and says which kind of nothing it was", () => {
  // ① 没有桥、浏览器权限未授予：无可用渠道，而且不是「抛错回退」。
  for (const permission of ["denied", "default"]) {
    const harness = createHarness({ permission });
    const result = harness.delivery.deliver(notice(), { background: true });

    assert.equal(result.outcome, DELIVERY_OUTCOMES.NO_CHANNEL);
    assert.equal(result.delivered, false);
    assert.equal(result.channel, `browser-${permission}`);
    assert.equal(result.fellBack, false);
    assert.equal(harness.notices.length, 0);
    assert.equal(harness.deliveries().at(-1).delivered, false);
    assert.equal(harness.deliveries().at(-1).channel, `browser-${permission}`);
  }

  // ② 完全没有 Notification API：同样是无可用渠道，渠道名可区分。
  const unsupported = createHarness({ notification: false });
  const noApi = unsupported.delivery.deliver(notice(), { background: true });
  assert.equal(noApi.outcome, DELIVERY_OUTCOMES.NO_CHANNEL);
  assert.equal(noApi.channel, "browser-unsupported");
  assert.equal(noApi.delivered, false);

  // ③ 同一个「没投出去」的结果，靠 outcome/fellBack 区分「本来就没渠道」与「渠道抛错后回退」。
  const threw = createHarness({ permission: "denied" });
  throwingBridges(threw);
  const afterThrow = threw.delivery.deliver(notice(), { background: true });
  assert.equal(afterThrow.outcome, DELIVERY_OUTCOMES.NO_CHANNEL);
  assert.equal(afterThrow.delivered, false);
  assert.equal(afterThrow.fellBack, true);
  assert.equal(threw.notices.length, 0);
});

test("hands the reminder to the browser API and reports the request body as-is", () => {
  const harness = createHarness();
  const result = harness.delivery.deliver(notice(), { background: false });

  assert.equal(result.outcome, DELIVERY_OUTCOMES.BROWSER);
  assert.equal(result.delivered, true);
  assert.equal(result.fellBack, false);
  assert.equal(harness.notices.length, 1);
  const { title, options } = harness.notices[0];
  assert.equal(title, "Session ended (reason not read)");
  assert.equal(options.body, "Background session");
  assert.equal(options.renotify, true);
  assert.equal(options.silent, false);
  assert.equal(harness.deliveries().at(-1).background, false);
});

test("feeds every platform event back to the injected sink", () => {
  const harness = createHarness();
  harness.delivery.deliver(notice({ sessionId: "s9" }), { background: true });
  const system = harness.notices[0];

  system.onshow();
  system.onerror({ error: "boom" });
  system.onclose();

  assert.deepEqual(harness.platformReports(), [
    { key: "terminal:s1:1", event: "onshow", error: null },
    { key: "terminal:s1:1", event: "onerror", error: "boom" },
    { key: "terminal:s1:1", event: "onclose", error: null }
  ]);
  // 调用方拿到的回灌保留原始 error（`onshow`/`onclose` 没有 error 就是 undefined）。
  assert.deepEqual(harness.platforms, [
    { key: "terminal:s1:1", kind: "terminal", event: "onshow", error: void 0 },
    { key: "terminal:s1:1", kind: "terminal", event: "onerror", error: "boom" },
    { key: "terminal:s1:1", kind: "terminal", event: "onclose", error: void 0 }
  ]);

  // 平台没有 error 字段时也要给出可读的原因，不能写 undefined。
  system.onerror({});
  assert.equal(harness.platformReports().at(-1).error, "unknown");
});

test("opens the session and closes the notice when the browser notice is clicked", () => {
  const harness = createHarness();
  harness.delivery.deliver(notice({ sessionId: "s9" }), { background: true });

  harness.notices[0].onclick();

  assert.deepEqual(harness.opened, ["s9"]);
  assert.equal(harness.notices[0].closed, true);
  assert.equal(harness.focusedCount, 1);
});

test("uses a short unique tag and never asks for requireInteraction (ADR-0001)", () => {
  const harness = createHarness();
  for (let index = 0; index < 5; index += 1) {
    harness.delivery.deliver(notice({ key: `terminal:s1:${index}` }), { background: true });
  }

  assert.equal(harness.notices.length, 5);
  const tags = harness.notices.map((entry) => entry.options.tag);
  assert.equal(new Set(tags).size, 5);
  for (const tag of tags) {
    assert.match(tag, /^dshss-\d+$/);
    // Windows toast 对 tag 长度敏感：不能把会话 id 拼进去（曾达 94 字符）。
    assert.ok(tag.length <= 24, `tag too long: ${tag}`);
  }
  for (const entry of harness.notices) {
    assert.equal(Object.prototype.hasOwnProperty.call(entry.options, "requireInteraction"), false);
    assert.equal(entry.options.requireInteraction, void 0);
  }
  // 平台事件按 key 关联，tag 与 key 是两件事（tag 不能承担去重语义）。
  assert.equal(harness.notices[0].options.tag === harness.notices[1].options.tag, false);
});

test("keeps delivering when the sink is missing or throws", () => {
  const bare = createDelivery({ window: { dshShell: { notify: () => {} } } });
  let result;
  assert.doesNotThrow(() => { result = bare.deliver(notice(), { background: true }); });
  assert.equal(result.delivered, true);
  assert.equal(result.outcome, DELIVERY_OUTCOMES.NATIVE_BRIDGE);

  const harness = createHarness({ report: () => { throw new Error("sink down"); } });
  assert.doesNotThrow(() => { result = harness.delivery.deliver(notice(), { background: true }); });
  assert.equal(result.delivered, true);
  assert.equal(harness.notices.length, 1);
});

test("reports capability and requests browser permission only when there is no bridge", async () => {
  const browserOnly = createHarness({ permission: "default" });
  assert.equal(browserOnly.delivery.permission(), "default");
  assert.equal(browserOnly.delivery.browserPermission(), "default");
  assert.equal(browserOnly.delivery.nativeBridge(), false);

  browserOnly.FakeNotification.permission = "granted";
  assert.deepEqual(await browserOnly.delivery.requestPermission(), { permission: "granted", resync: true });
  assert.equal(browserOnly.FakeNotification.requests, 1);

  const withBridge = createHarness();
  withBridge.window.dshShell = { notify: () => {} };
  assert.equal(withBridge.delivery.permission(), "native");
  assert.equal(withBridge.delivery.nativeBridge(), true);
  assert.deepEqual(await withBridge.delivery.requestPermission(), { permission: "native", resync: true });
  assert.equal(withBridge.FakeNotification.requests, 0);

  // 两次桥都抛错后再问权限：能力退回浏览器权限（原生桥已被证明不可用）。
  const failed = createHarness();
  throwingBridges(failed);
  failed.delivery.deliver(notice(), { background: true });
  assert.equal(failed.delivery.nativeBridge(), true);
  assert.equal(failed.delivery.permission(), "granted");

  const withoutApi = createHarness({ notification: false });
  assert.equal(withoutApi.delivery.permission(), "unsupported");
  assert.deepEqual(await withoutApi.delivery.requestPermission(), { permission: "unsupported", resync: false });
});

test("reads capability from injected doubles instead of guessing", () => {
  assert.equal(hasNativeBridge({ dshShell: { notify() {} } }), true);
  assert.equal(hasNativeBridge({ chrome: { webview: { postMessage() {} } } }), true);
  assert.equal(hasNativeBridge({ dshShell: {}, chrome: {} }), false);
  assert.equal(hasNativeBridge(null), false);

  assert.equal(readBrowserPermission({ permission: "denied" }), "denied");
  assert.equal(readBrowserPermission({}), "default");
  assert.equal(readBrowserPermission(null), "unsupported");
  assert.equal(readBrowserPermission({ get permission() { throw new Error("nope"); } }), "unsupported");
});

test("reads sticky user activation from the platform, and says null when there is none", () => {
  // 装配层把这份事实并进投递记录（曾经只在 vm 契约测试里断过），映射本身在这里直测。
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const withNavigator = (value) => Object.defineProperty(globalThis, "navigator", { value, configurable: true });
  try {
    withNavigator({ userActivation: { isActive: true, hasBeenActive: true } });
    assert.deepEqual(readUserActivation(), { active: true, everActive: true });

    withNavigator({ userActivation: { isActive: false, hasBeenActive: true } });
    assert.deepEqual(readUserActivation(), { active: false, everActive: true });

    // 没有 `userActivation`（Node、老 WebView）：给 null，不编一个默认值。
    withNavigator({});
    assert.equal(readUserActivation(), null);

    // 读取本身抛错也只是一次没有事实，不能反过来影响投递。
    withNavigator({ get userActivation() { throw new Error("no activation"); } });
    assert.equal(readUserActivation(), null);
  } finally {
    if (descriptor === undefined) delete globalThis.navigator;
    else Object.defineProperty(globalThis, "navigator", descriptor);
  }
});

// —— 渠道 adapter 序列（.scratch/session-status/issues/05-delivery-channel-adapters.md）与能力/权限的单一来源（.scratch/session-status/issues/13-foreground-single-source.md）——

/**
 * adapter 级替身：只注入渠道做副作用所需的那些口（不模拟浏览器）。每个 adapter 都
 * 拿得到 `capability()`（与 `createDelivery` 内部同一个派生函数），因此可用性可以单独断言。
 */
function adapterHarness({ windowLike = {}, permission = "granted", notification = true, throws = false } = {}) {
  const posts = [];
  const platforms = [];
  const opened = [];
  const failures = [];
  const notices = [];
  let tags = 0;

  class FakeNotification {
    static permission = permission;
    static async requestPermission() { return permission; }
    constructor(title, options) {
      if (throws) throw new Error("constructor refused");
      this.title = title;
      this.options = options;
      this.closed = false;
      notices.push(this);
    }
    close() { this.closed = true; }
  }

  const ctor = notification ? FakeNotification : null;
  const onError = (label, error) => failures.push({ label, error });

  return {
    windowLike,
    FakeNotification,
    notices,
    posts,
    platforms,
    opened,
    failures,
    onError,
    capability: () => readCapabilities({ window: windowLike, notificationCtor: ctor }),
    adapters: createChannelAdapters({
      readWindow: () => windowLike,
      readNotification: () => ctor,
      pluginId: PLUGIN_ID,
      nextTag: () => `dshss-${++tags}`,
      onError,
      openSession: (sessionId) => opened.push(sessionId),
      report: (event, payload) => posts.push({ event, payload }),
      onPlatform: (feedback) => platforms.push(feedback)
    })
  };
}

test("每个渠道都是独立可测的 adapter：自己声明可用性与三种投递结果", () => {
  const granted = adapterHarness({
    windowLike: { dshShell: { notify() {} }, chrome: { webview: { postMessage() {} } } }
  });
  const [shell, webview, browser] = granted.adapters;
  assert.deepEqual(granted.adapters.map((adapter) => adapter.id),
    [CHANNEL_IDS.SHELL, CHANNEL_IDS.WEBVIEW, CHANNEL_IDS.BROWSER]);

  const context = { notice: notice(), capability: granted.capability() };
  assert.deepEqual(granted.adapters.map((adapter) => adapter.available(context)), [true, true, true]);

  // 接住：两个原生桥共用一个落盘 channel（"native-bridge"），浏览器一个。
  assert.deepEqual(shell.results.accepted, { channel: "native-bridge", outcome: DELIVERY_OUTCOMES.NATIVE_BRIDGE });
  assert.deepEqual(browser.results.accepted, { channel: "browser", outcome: DELIVERY_OUTCOMES.BROWSER });
  assert.equal(shell.send(context).result, ADAPTER_RESULTS.ACCEPTED);
  assert.equal(webview.send(context).result, ADAPTER_RESULTS.ACCEPTED);
  assert.equal(browser.send(context).result, ADAPTER_RESULTS.ACCEPTED);
  assert.equal(granted.notices.length, 1);

  // 被拒：桥的 send 直接抛（没有终局结论，交给后续渠道）；浏览器给的是终局拒绝。
  granted.windowLike.dshShell = { notify() { throw new Error("bridge unavailable"); } };
  assert.throws(() => shell.send(context), /bridge unavailable/);
  assert.equal(shell.results.rejected, null);
  assert.deepEqual(browser.results.rejected, { channel: "browser-error", outcome: DELIVERY_OUTCOMES.BROWSER_ERROR });

  // 不可用：原生桥没有话要说，浏览器负责这一轮「无渠道」的措辞（权限 / 没有 API）。
  const denied = adapterHarness({ permission: "denied" });
  const deniedContext = { notice: notice(), capability: denied.capability() };
  assert.deepEqual(denied.adapters.map((adapter) => adapter.available(deniedContext)), [false, false, false]);
  assert.equal(denied.adapters[0].results.unavailable, null);
  assert.deepEqual(denied.adapters[2].results.unavailable(deniedContext),
    { channel: "browser-denied", outcome: DELIVERY_OUTCOMES.NO_CHANNEL });

  const unsupported = adapterHarness({ notification: false });
  const unsupportedContext = { notice: notice(), capability: unsupported.capability() };
  assert.deepEqual(unsupported.adapters[2].results.unavailable(unsupportedContext),
    { channel: "browser-unsupported", outcome: DELIVERY_OUTCOMES.NO_CHANNEL });
});

test("顺序与回退由序列驱动：shell 抛错 → webview；两个都抛 → 浏览器", () => {
  const run = (harness) => runDeliveryChain(harness.adapters, {
    notice: notice(),
    capability: harness.capability(),
    onError: harness.onError
  });

  // ① shell 抛错、webview 接住：错误表里只有 shell，接住即停（不再问浏览器）。
  const first = adapterHarness({
    windowLike: { dshShell: { notify() { throw new Error("down"); } }, chrome: { webview: { postMessage() {} } } }
  });
  const oneStep = run(first);
  assert.equal(oneStep.delivered, true);
  assert.equal(oneStep.adapter.id, CHANNEL_IDS.WEBVIEW);
  assert.equal(oneStep.channel, "native-bridge");
  assert.equal(oneStep.outcome, DELIVERY_OUTCOMES.NATIVE_BRIDGE);
  assert.deepEqual(oneStep.errors.map((entry) => entry.channel), [CHANNEL_IDS.SHELL]);
  assert.deepEqual(oneStep.consulted, [CHANNEL_IDS.SHELL, CHANNEL_IDS.WEBVIEW]);

  // ② 两个桥都抛错：退回浏览器，两笔错误都在表里，日志标签来自渠道自己。
  const both = adapterHarness({
    windowLike: {
      dshShell: { notify() { throw new Error("shell down"); } },
      chrome: { webview: { postMessage() { throw new Error("webview down"); } } }
    }
  });
  const fellBack = run(both);
  assert.equal(fellBack.delivered, true);
  assert.equal(fellBack.adapter.id, CHANNEL_IDS.BROWSER);
  assert.deepEqual(fellBack.errors.map((entry) => entry.channel), [CHANNEL_IDS.SHELL, CHANNEL_IDS.WEBVIEW]);
  assert.deepEqual(fellBack.consulted, [CHANNEL_IDS.SHELL, CHANNEL_IDS.WEBVIEW, CHANNEL_IDS.BROWSER]);
  assert.deepEqual(both.failures.map((entry) => entry.label),
    ["shell notification failed", "WebView notification failed"]);

  // ③ 没有任何桥、权限也没给：终局渠道给「无渠道」的措辞，且这不是回退（错误表为空）。
  const none = adapterHarness({ permission: "default" });
  const empty = run(none);
  assert.equal(empty.delivered, false);
  assert.equal(empty.channel, "browser-default");
  assert.equal(empty.outcome, DELIVERY_OUTCOMES.NO_CHANNEL);
  assert.deepEqual(empty.errors, []);

  // ④ 浏览器 API 在但构造抛错：终局拒绝（不是「无渠道」），且不计入回退错误表——
  //    终局渠道没有「后续渠道」可言。
  const broken = adapterHarness({ throws: true });
  const refused = run(broken);
  assert.equal(refused.delivered, false);
  assert.equal(refused.channel, "browser-error");
  assert.equal(refused.outcome, DELIVERY_OUTCOMES.BROWSER_ERROR);
  assert.deepEqual(refused.errors, []);
  assert.deepEqual(broken.failures.map((entry) => entry.label), ["system notification failed"]);
});

test("一次投递只派生一次能力值：可用性判定、结果与上报体用的是同一个 (.scratch/session-status/issues/13-foreground-single-source.md)", () => {
  let permissionReads = 0;
  class FlippingNotification {
    static get permission() {
      permissionReads += 1;
      return permissionReads === 1 ? "granted" : "denied";
    }
    constructor(title, options) { this.options = options; }
    close() {}
  }

  const reports = [];
  const delivery = createDelivery({
    window: { focus() {} },
    notificationCtor: FlippingNotification,
    report: (event, payload) => reports.push({ event, payload }),
    now: () => new Date("2026-09-26T10:20:30Z")
  });

  const result = delivery.deliver(notice(), { background: true });

  assert.equal(result.outcome, DELIVERY_OUTCOMES.BROWSER);
  assert.equal(result.channel, "browser");
  assert.equal(result.capability.browserPermission, "granted");
  assert.equal(result.browserPermission, "granted");
  // 一次投递只问一次「现在有哪些渠道可用」：再读一次就会读到 denied，从而与决策分叉。
  assert.equal(permissionReads, 1);
  const reported = reports.find((entry) => entry.event === "deliver").payload;
  assert.equal(reported.browserPermission, "granted");
  assert.equal(reported.channel, "browser");
});

test("能力/权限只有一个来源：设置区那一问与投递决策取的是同一个派生值", () => {
  class FakeNotification {
    static permission = "granted";
    static async requestPermission() { return "granted"; }
    constructor() {}
    close() {}
  }
  const withBridge = createDelivery({
    window: { dshShell: { notify() {} } },
    notificationCtor: FakeNotification
  });

  const capability = withBridge.capability();
  assert.equal(withBridge.permission(), capability.permission);
  assert.equal(withBridge.browserPermission(), capability.browserPermission);
  assert.equal(withBridge.nativeBridge(), capability.nativeBridge);
  assert.equal(capability.permission, "native");
  assert.equal(capability.nativeBridge, true);
  // 逐渠道的可用性也在同一个值里：adapter 只读它，不自己碰宿主对象。
  assert.deepEqual(Object.keys(capability.channels), [CHANNEL_IDS.SHELL, CHANNEL_IDS.WEBVIEW, CHANNEL_IDS.BROWSER]);
  assert.equal(capability.channels.browser.available, true);
  assert.equal(capability.channels.shell.claimed, true);

  // 决策用的那个值随结果一起回国，调用方（诊断记录/设置区）不必再算一次。
  const reports = [];
  const reporting = createDelivery({
    window: { dshShell: { notify() {} } },
    notificationCtor: FakeNotification,
    report: (event, payload) => reports.push({ event, payload })
  });
  const result = reporting.deliver(notice(), { background: true });
  const reported = reports.at(-1).payload;
  assert.equal(reported.nativeBridge, result.capability.nativeBridge);
  assert.equal(reported.browserPermission, result.capability.browserPermission);
  assert.equal(reported.userActivation, result.capability.userActivation);
  assert.equal(result.activation, result.capability.userActivation);
});
