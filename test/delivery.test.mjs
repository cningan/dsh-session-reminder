/**
 * 投递层直测（`lib/client/delivery.mjs`）：不模拟整个浏览器，只注入最小替身
 * （window 桥、Notification 构造器、注入的 sink）。判定与前台否决都不在这个 module，
 * 因此这里也只覆盖渠道选择、平台事件回灌与通知参数。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  createDelivery,
  DELIVERY_OUTCOMES,
  hasNativeBridge,
  readBrowserPermission
} from "../lib/client/delivery.mjs";

const PLUGIN_ID = "@cningan/dsh-session-status";

function notice(overrides = {}) {
  return {
    key: "terminal:s1:1",
    kind: "terminal",
    sessionId: "s1",
    title: "Session interrupted or stopped",
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
    title: "Session interrupted or stopped",
    message: "Background session"
  }]);
  // 原生桥被接住时不碰浏览器 API。
  assert.equal(harness.notices.length, 0);
  assert.deepEqual(harness.deliveries(), [{
    key: "terminal:s1:1",
    kind: "terminal",
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
  assert.equal(harness.notices[0].title, "Session interrupted or stopped");
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
  assert.equal(title, "Session interrupted or stopped");
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
