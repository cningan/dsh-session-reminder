import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const clientBundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

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

function createHarness({ statuses = new Map(), currentId, detailBySession = {}, bindings = {}, native = "browser", focused = false, browserPermission, localeLanguage = "en" } = {}) {
  const notices = [];
  const shellPayloads = [];
  const webviewPayloads = [];
  const registrations = [];
  const handlers = new Map();
  const cleanup = [];
  const opened = [];
  const effectiveBrowserPermission = browserPermission ?? (native === "browser" ? "granted" : "default");

  class MockNotification {
    static permission = effectiveBrowserPermission;
    static async requestPermission() { return MockNotification.permission; }
    constructor(title, options) {
      this.title = title;
      this.options = options;
      notices.push(this);
    }
    close() {}
  }

  const window = {
    addEventListener(name, listener) {
      const group = handlers.get(name) || new Set();
      group.add(listener);
      handlers.set(name, group);
    },
    removeEventListener(name, listener) { handlers.get(name)?.delete(listener); },
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
  if (native === "shell") window.dshShell = { notify: (payload) => shellPayloads.push(payload) };
  if (native === "webview") window.chrome = { webview: { postMessage: (payload) => webviewPayloads.push(payload) } };
  if (native === "shell-throws-webview") {
    window.dshShell = { notify: () => { throw new Error("bridge unavailable"); } };
    window.chrome = { webview: { postMessage: (payload) => webviewPayloads.push(payload) } };
  }
  if (native === "both-bridges-throw") {
    window.dshShell = { notify: () => { throw new Error("shell unavailable"); } };
    window.chrome = { webview: { postMessage: () => { throw new Error("WebView unavailable"); } } };
  }

  const document = {
    visibilityState: "visible",
    documentElement: { lang: "en" },
    head: null,
    hasFocus: () => focused,
    addEventListener(name, listener) {
      const group = handlers.get(`document:${name}`) || new Set();
      group.add(listener);
      handlers.set(`document:${name}`, group);
    },
    removeEventListener(name, listener) { handlers.get(`document:${name}`)?.delete(listener); },
    querySelector: () => null
  };

  const list = observable({ byId: {
    active: { title: "Active session" },
    background: { title: "Background session" },
    current: { title: "Current session" }
  } });
  const sessionStatus = observable(statuses);
  const current = observable({ key: currentId });
  const connectionState = observable("connected");
  const detailSources = new Map(Object.entries(detailBySession));
  // 官方 locale 服务替身：捕获插件注册的字典，按 `localeLanguage` 解析 `{param}` 插值。
  let registeredDictionaries;
  const translate = (key, params) => {
    const table = registeredDictionaries?.[localeLanguage] ?? {};
    const template = typeof table[key] === "string" ? table[key] : key;
    if (params === void 0) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
  const ctx = {
    sessions: {
      list,
      binding: (id) => {
        const session = detailSources.get(id);
        const configured = bindings[id];
        if (session === void 0 && configured === void 0) return void 0;
        return { ...configured, ...(session === void 0 ? {} : { session }) };
      },
      open: (id) => opened.push(id)
    },
    uiSession: { sessionStatus, adapter: { current } },
    connection: { state: connectionState },
    locale: {
      register(_namespace, dictionaries) { registeredDictionaries = dictionaries; return () => {}; },
      bind(_namespace) { return translate; }
    },
    effect(effect) {
      const dispose = effect();
      if (typeof dispose === "function") cleanup.push(dispose);
      return dispose;
    },
    slots: {
      inject(_slot, callback) { callback(); return () => {}; },
      register(meta, render) { registrations.push({ meta, render }); return () => {}; }
    }
  };

  vm.runInNewContext(clientBundle, {
    window,
    document,
    navigator: { language: "en" },
    Notification: MockNotification,
    Map,
    console: { log() {}, info() {}, warn() {}, error() {} }
  }, { filename: "lib/client.js" });
  window.plugin.apply(ctx);

  const registration = registrations[0];
  const settingsProps = typeof registration.meta.inject === "function" ? registration.meta.inject() : {};
  const settingsElement = registration.render(settingsProps);
  return {
    notices,
    shellPayloads,
    webviewPayloads,
    opened,
    registration,
    settingsElement,
    model: settingsProps.model,
    setRows: (byId) => list.set({ byId }),
    setStatuses: (next) => sessionStatus.set(next),
    setConnection: (next) => connectionState.set(next),
    triggerWindow: (name) => {
      for (const listener of [...(handlers.get(name) || [])]) listener();
    },
    triggerDocument: (name) => {
      for (const listener of [...(handlers.get(`document:${name}`) || [])]) listener();
    },
    cleanup
  };
}

test("does not guess success from a background unread marker", () => {
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([
      ["current", { running: true, completionUnread: false }],
      ["background", { running: true, completionUnread: false }]
    ])
  });

  harness.setStatuses(new Map([
    ["current", { running: true, completionUnread: false }],
    ["background", { running: false, completionUnread: true }]
  ]));

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "Session interrupted or stopped");
  assert.match(harness.notices[0].options.body, /reason is unavailable/);
});

test("treats a newly pending interaction as the single reason for a stopped run", () => {
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["background", { running: true, completionUnread: false }]])
  });
  const interaction = { kind: "question" };
  const stopped = new Map([["background", { running: false, pendingInteraction: interaction, completionUnread: false }]]);

  harness.setStatuses(stopped);
  harness.setStatuses(new Map(stopped));

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0].title, /waiting for your answer/);
  assert.equal(harness.notices[0].options.body, "Background session");
});

test("uses a non-misleading generic message when a background stop has no cause data", () => {
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["background", { running: true, completionUnread: false }]])
  });

  harness.setStatuses(new Map([["background", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0].options.body, /Background session/);
  assert.match(harness.notices[0].options.body, /reason is unavailable/);
});

test("uses Session turn/end reasons for normal completion", () => {
  const session = observable({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null });
  const eventSource = observable({ events: [], target: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["current", { running: true, completionUnread: false }]]),
    bindings: { current: { session, eventSource } }
  });

  eventSource.set({ events: [{ seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } }], target: { seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } } });
  harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "Session run completed");
});

test("includes the reason from a failed turn/end event", () => {
  const session = observable({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null });
  const eventSource = observable({ events: [], target: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["current", { running: true, completionUnread: false }]]),
    bindings: { current: { session, eventSource } }
  });

  eventSource.set({ events: [{ seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "MODEL_ERR", message: "quota exhausted" } } } }], target: { seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "MODEL_ERR", message: "quota exhausted" } } } } });
  harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0].options.body, /MODEL_ERR: quota exhausted/);
});

test("uses a generic notice when a turn end does not identify who interrupted it", () => {
  const session = observable({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null });
  const eventSource = observable({ events: [], target: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["current", { running: true, completionUnread: false }]]),
    bindings: { current: { session, eventSource } }
  });

  eventSource.set({ events: [{ seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } }], target: { seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } } });
  harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0].options.body, /reason is unavailable/);
});

test("includes a selected-session runtime error from SessionSnapshot", () => {
  const session = observable({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["current", { running: true, completionUnread: false }]]),
    detailBySession: { current: session }
  });

  session.set({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: "runtime blew up" });
  assert.equal(harness.notices.length, 0);
  harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 1);
  assert.match(harness.notices[0].options.body, /runtime blew up/);
});

test("suppresses an explicitly user-cancelled turn", () => {
  const session = observable({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null });
  const eventSource = observable({ events: [], target: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["current", { running: true, completionUnread: false }]]),
    bindings: { current: { session, eventSource } }
  });

  eventSource.set({ events: [{ seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } }], target: { seq: 1, time: 1, type: "turn/end", data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } } });
  harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 0);
});

test("does not notify when the selected SessionSnapshot explicitly marks removal", () => {
  const session = observable({ running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["current", { running: true, completionUnread: false }]]),
    detailBySession: { current: session }
  });

  session.set({ running: false, removed: true, openState: "open", openError: null, promptError: null, lastAgentError: null });
  harness.setStatuses(new Map([["current", { running: false, completionUnread: false }]]));

  assert.equal(harness.notices.length, 0);
});

test("does not turn a session-list removal into a stop notice", () => {
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["background", { running: true, completionUnread: false }]])
  });

  harness.setRows({ current: { title: "Current session" } });
  harness.setStatuses(new Map([["background", { running: false, completionUnread: true }]]));

  assert.equal(harness.notices.length, 0);
});

test("does not notify for an initially idle session or a connection loss alone", () => {
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([["background", { running: false, completionUnread: false }]])
  });

  harness.setConnection("connecting");
  harness.setConnection("disconnected");

  assert.equal(harness.notices.length, 0);
});

test("uses the workbench notification bridge when it is available", () => {
  const harness = createHarness({ native: "shell" });

  assert.equal(harness.model.getSnapshot().notificationPermission, "native");
  assert.equal(harness.model.sendTestNotification(), true);
  assert.equal(harness.shellPayloads.length, 1);
  assert.equal(harness.notices.length, 0);
});

test("continues to WebView when the shell notification bridge throws", () => {
  const harness = createHarness({ native: "shell-throws-webview" });

  assert.equal(harness.model.sendTestNotification(), true);
  assert.equal(harness.shellPayloads.length, 0);
  assert.equal(harness.webviewPayloads.length, 1);
  assert.equal(harness.notices.length, 0);
});

test("falls back to granted browser notifications when every native bridge throws", () => {
  const harness = createHarness({ native: "both-bridges-throw", browserPermission: "granted" });

  assert.equal(harness.model.getSnapshot().notificationPermission, "native");
  assert.equal(harness.model.sendTestNotification(), true);
  assert.equal(harness.model.getSnapshot().notificationPermission, "granted");
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.shellPayloads.length, 0);
  assert.equal(harness.webviewPayloads.length, 0);
});

test("recognizes the WebView bridge as a native delivery capability", () => {
  const harness = createHarness({ native: "webview" });

  assert.equal(harness.model.getSnapshot().notificationPermission, "native");
  assert.equal(harness.model.sendTestNotification(), true);
  assert.equal(harness.webviewPayloads.length, 1);
  assert.equal(harness.notices.length, 0);
});

test("does not notify while the DSH page is foregrounded", () => {
  const harness = createHarness({
    currentId: "current",
    focused: true,
    statuses: new Map([["background", { running: true, completionUnread: false }]])
  });

  harness.setStatuses(new Map([["background", { running: false, completionUnread: true }]]));

  assert.equal(harness.notices.length, 0);
});

test("registers its settings as a plugin settings section, not a general settings row", () => {
  const harness = createHarness({ currentId: "current" });

  assert.equal(harness.registration.meta.name, "settings.section");
  assert.equal(harness.registration.meta.id, "@cningan/dsh-session-status");
  assert.equal(typeof harness.registration.meta.label, "function");
  assert.equal(harness.registration.meta.label(), "Session reminders");
});

test("follows the official locale dictionary instead of guessing from the document or navigator", () => {
  const harness = createHarness({
    currentId: "current",
    localeLanguage: "zh",
    statuses: new Map([["background", { running: true, completionUnread: false }]])
  });

  harness.setStatuses(new Map([["background", { running: false, completionUnread: true }]]));

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "会话已中断或停止");
  assert.match(harness.notices[0].options.body, /Background session/);
  assert.match(harness.notices[0].options.body, /无法确定原因/);
  assert.equal(harness.registration.meta.label(), "会话提醒");
});
