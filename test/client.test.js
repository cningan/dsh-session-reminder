/**
 * 装配级集成测试：**唯一**一份「假浏览器」，只为把真正的产物（`lib/client.js`，DSH loader
 * bundle）装起来跑「订阅 → 判定 → 文案 → 投递 → 上报」这条完整链路。
 *
 * 判定族（停止/运行边沿、原因分类、去重、抑制、等待优先于停止、tag 唯一性、权限派生）
 * 以及各 module 内部的行为，全部由 Node 直测承担——`test/core-*.test.mjs`、
 * `test/delivery.test.mjs`、`test/diagnostics-sink.test.mjs`、`test/settings.test.mjs`、
 * `test/test-service.test.mjs`、`test/model-surface.test.mjs`、`test/client-assembly.test.mjs`；
 * 它们不 `import vm`、不模拟浏览器。本文件不再逐条重建假浏览器。
 *
 * 留在这里的断言都是**装配层独有**、别处观察不到的事实：
 *   - 官方源的读取与归一化（列表行 / 状态 / 当前会话绑定 → 领域快照；官方快照的字段名）
 *   - `turn/end` 事件窗口缓存，以及「新一轮丢弃上一轮原因」的定界
 *   - 语义 → 通知标题/正文的文案组装（含跟随官方 locale 词典的语言）
 *   - 前台否决的**记账与上报**（按设计静默也要写一条可区分的投递记录）
 *   - 测试服务的临时投递与自动提醒共用同一个投递出口，因此同样服从前台否决
 *   - `settings.section` 的注册元数据（name / id / order / label）
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

// `pretest` 先构建产物，测试针对它运行（构建脚本只有一种产物）。
const clientBundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");

const DIAGNOSTICS_PATH = "/plugins/dsh-session-status/diagnostics";

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

/** `Map` 的一项：正在运行、未读为假。 */
const running = (id) => [id, { running: true, completionUnread: false }];

/** `Map` 的一项：已停止。 */
const stopped = (id, overrides = {}) => [id, { running: false, completionUnread: false, ...overrides }];

/**
 * 装配替身：官方源（列表 / 状态 / 当前会话 / 连接 / locale / slots / effect / provide）全部注入，
 * 外加最小假 window / document / Notification / fetch。返回观察点，不返回任何实现细节。
 *
 * `bridges: "throwing"` 表示两个原生桥都在场但都会抛错（用来观察渠道回退）。
 */
function createHarness({
  statuses = new Map(),
  currentId,
  bindings = {},
  focused = false,
  localeLanguage = "en",
  bridges = "none",
  browserPermission = "granted"
} = {}) {
  const notices = [];
  const reports = [];
  const bridgeAttempts = [];
  const registrations = [];
  const provided = {};
  const handlers = new Map();

  class MockNotification {
    static permission = browserPermission;
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
  if (bridges === "throwing") {
    window.dshShell = {
      notify(payload) {
        bridgeAttempts.push({ channel: "shell", payload });
        throw new Error("bridge unavailable");
      }
    };
    window.chrome = {
      webview: {
        postMessage(payload) {
          bridgeAttempts.push({ channel: "webview", payload });
          throw new Error("WebView unavailable");
        }
      }
    };
  }

  const document = {
    visibilityState: "visible",
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
    background: { title: "Background session" },
    current: { title: "Current session" }
  } });
  const sessionStatus = observable(statuses);
  const current = observable({ key: currentId });
  const connectionState = observable("connected");

  // 官方 locale 服务替身：收下插件注册的字典，按 `localeLanguage` 解析 `{param}` 插值。
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
      binding: (id) => bindings[id],
      open: () => {}
    },
    uiSession: { sessionStatus, adapter: { current } },
    connection: { state: connectionState },
    locale: {
      register(_namespace, dictionaries) { registeredDictionaries = dictionaries; return () => {}; },
      bind(_namespace) { return translate; }
    },
    effect(effect) { effect(); },
    // Cordis 服务注册面：插件用 `ctx.provide("sessionStatusTest", service)` 交出测试服务
    // （官方 locale 服务同款用法）。这里只收下它，测试通过返回值消费。
    provide(name, value) {
      provided[name] = value;
      return () => { delete provided[name]; };
    },
    slots: {
      inject(_slot, callback) { callback(); return () => {}; },
      register(meta, render) { registrations.push({ meta, render }); return () => {}; }
    }
  };

  vm.runInNewContext(clientBundle, {
    window,
    document,
    navigator: { language: "en", userActivation: { isActive: false, hasBeenActive: false } },
    Notification: MockNotification,
    Map,
    setTimeout: (fn) => { try { fn(); } catch {} return 0; },
    clearTimeout: () => {},
    fetch: (path, options) => {
      try {
        reports.push({ path, body: JSON.parse(options?.body ?? "{}") });
      } catch {}
      return Promise.resolve({ ok: true });
    },
    console: { log() {}, info() {}, warn() {}, error() {} }
  }, { filename: "lib/client.js" });
  window.plugin.apply(ctx);

  const registration = registrations[0];
  const settingsProps = typeof registration.meta.inject === "function" ? registration.meta.inject() : {};
  return {
    notices,
    reports,
    bridgeAttempts,
    registration,
    model: settingsProps.model,
    service: provided.sessionStatusTest,
    setStatuses: (next) => sessionStatus.set(next),
    setRows: (byId) => list.set({ byId }),
    /** 某一类诊断事件的 payload 列表（读方落盘的记录形状）。 */
    payloads: (event) => reports.filter((entry) => entry.body.event === event).map((entry) => entry.body.payload)
  };
}

test("后台停止边沿端到端：判定 → 文案 → 投递 → 逐条上报（含被抑制的边沿）", () => {
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([running("current"), running("background")])
  });

  // 后台会话停止，上游只留下「未读」标记、没有任何原因数据：未读不证明成功，
  // 装配层组出「会话标题 + 分隔符 + 通用停止说明」的正文。
  harness.setStatuses(new Map([running("current"), stopped("background", { completionUnread: true })]));

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "Session interrupted or stopped");
  assert.equal(
    harness.notices[0].options.body,
    "Background session: The session stopped, but the reason is unavailable"
  );

  // 上报链的另一半：装载快照与状态源形状（读方 `diagnose` 依赖的字段）。
  const attach = harness.reports.find((entry) => entry.body.event === "attach");
  assert.equal(attach.path, DIAGNOSTICS_PATH);
  assert.equal(attach.body.payload.hasSessionsList, true);
  assert.equal(attach.body.payload.hasSessionStatus, true);
  const status = harness.payloads("status")[0];
  assert.equal(status.currentInStatuses, true);
  assert.equal(status.listHandlesCurrent, true);

  // 边沿事实与投递结果逐条落盘。
  const edges = harness.payloads("edge");
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "terminal");
  assert.equal(edges[0].suppressed, null);
  const deliveries = harness.payloads("deliver");
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].channel, "browser");
  assert.equal(deliveries[0].delivered, true);
  assert.equal(deliveries[0].background, true);

  // 新的 run 里出现新的等待对象：只投一条等待提醒——标题是等待文案、正文是会话标题
  // （等待优先于停止由 core/decide 直测覆盖，这里验的是文案组装与投递）。
  harness.setStatuses(new Map([running("current"), running("background")]));
  harness.setStatuses(new Map([
    running("current"),
    stopped("background", { pendingInteraction: { kind: "question" } })
  ]));

  assert.equal(harness.notices.length, 2);
  assert.equal(harness.notices[1].title, "Session is waiting for your answer");
  assert.equal(harness.notices[1].options.body, "Background session");

  // 列表行消失的停止边沿：不投递（判定核心抑制），但仍有一条同形的边沿记录——
  // 读方据此区分「边沿被抑制」与「还没观察到边沿」。
  harness.setStatuses(new Map([running("current"), running("background")]));
  harness.setRows({ current: { title: "Current session" } });
  harness.setStatuses(new Map([running("current"), stopped("background", { completionUnread: true })]));

  assert.equal(harness.notices.length, 2);
  assert.equal(harness.payloads("edge").at(-1).kind, "terminal");
  assert.equal(harness.payloads("edge").at(-1).suppressed, "missing-list-row");
});

test("选中会话的原因来源端到端：turn/end 事件窗口 → 官方快照详情归一化 → 文案落地", () => {
  const session = observable({
    running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null
  });
  const eventSource = observable({ events: [], target: null });
  const harness = createHarness({
    currentId: "current",
    statuses: new Map([running("current")]),
    bindings: { current: { session, eventSource } }
  });

  const restart = () => harness.setStatuses(new Map([running("current")]));
  const stop = () => harness.setStatuses(new Map([stopped("current")]));
  // 事件窗口：`events` 与 `target` 是官方快照的两条来源，装配层按 seq 取最新的一条 type=turn/end。
  const publishTurnEnd = (seq, reason) => {
    const event = { seq, time: seq, type: "turn/end", data: { turn: seq, reason } };
    eventSource.set({ events: [event], target: event });
  };
  const sessionSnapshot = (overrides) => ({
    running: true, removed: false, openState: "open", openError: null, promptError: null, lastAgentError: null,
    ...overrides
  });

  // ① turn/end 说 completed：成功没有正文，标题用完成文案。
  publishTurnEnd(1, { kind: "completed" });
  stop();
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "Session run completed");
  assert.equal(harness.notices[0].options.body, "Current session");

  // ② turn/end 带失败原因：错误文本进正文。
  restart();
  publishTurnEnd(2, { kind: "error", error: { code: "MODEL_ERR", message: "quota exhausted" } });
  stop();
  assert.equal(harness.notices.length, 2);
  assert.match(harness.notices[1].options.body, /MODEL_ERR: quota exhausted/);

  // ③ turn/end 归因不明（`interrupted` 等于「没给出可用原因」）：回落到官方会话快照的详情字段。
  //    新一轮先丢弃上一轮的原因与详情，所以这里必须按「重启 → 详情 → 事件 → 停止」的顺序喂。
  restart();
  session.set(sessionSnapshot({ lastAgentError: "runtime blew up" }));
  publishTurnEnd(3, { kind: "interrupted" });
  stop();
  assert.equal(harness.notices.length, 3);
  assert.match(harness.notices[2].options.body, /runtime blew up/);

  // ④ 没有 turn/end 时同理，回落到 promptError（官方字段名 → 领域形状的归一化）。
  restart();
  session.set(sessionSnapshot({ promptError: { error: { code: "E_NET", message: "offline" } } }));
  stop();
  assert.equal(harness.notices.length, 4);
  assert.match(harness.notices[3].options.body, /E_NET: offline/);

  // ⑤ turn/end 说「被用户取消」：静默。判定由 core 直测锁定，这里验的是原始原因对象经事件
  //    窗口原样到达判定核心——嵌套的 abort 归属没有被装配层改写。
  restart();
  publishTurnEnd(4, { kind: "aborted", reason: { kind: "user" } });
  stop();
  assert.equal(harness.notices.length, 4);

  // ⑥ 官方快照显式标记移除：这是移除而不是停止，不投递。
  restart();
  session.set(sessionSnapshot({ removed: true }));
  stop();
  assert.equal(harness.notices.length, 4);
});

test("前台否决：自动提醒与测试服务的临时投递都不投递，但都写一条 suppressed-foreground 记录", () => {
  // 后台（默认失焦）：测试投递照常到达。
  const background = createHarness({ currentId: "current", statuses: new Map([running("current")]) });
  assert.equal(background.service.deliverAdHoc("test"), true);
  assert.equal(background.notices.length, 1);
  assert.equal(background.notices[0].title, "DSH reminder test");
  const backgroundDelivery = background.payloads("deliver").at(-1);
  assert.equal(backgroundDelivery.channel, "browser");
  assert.equal(backgroundDelivery.delivered, true);
  assert.equal(backgroundDelivery.key, "test-probe:test:1");

  const foreground = createHarness({
    currentId: "current",
    focused: true,
    statuses: new Map([running("current")])
  });

  // 自动提醒：前台不投递，但仍记一条可区分的投递记录（读方据此区分「按设计静默」与「投递故障」）。
  foreground.setStatuses(new Map([stopped("current")]));
  assert.equal(foreground.notices.length, 0);
  const suppressed = foreground.payloads("deliver").at(-1);
  assert.equal(suppressed.channel, "suppressed-foreground");
  assert.equal(suppressed.delivered, false);
  assert.equal(suppressed.background, false);

  // 测试服务经装配层的同一个投递出口投递（键前缀不同），所以同样服从前台否决。
  assert.equal(foreground.service.deliverAdHoc("test"), false);
  assert.equal(foreground.notices.length, 0);
  assert.equal(foreground.payloads("deliver").at(-1).channel, "suppressed-foreground");

  // 测试通道的覆盖只替换前台判定：覆盖成失焦后同一个调用就投得出去。
  foreground.service.setForegroundOverride("background");
  assert.equal(foreground.service.deliverAdHoc("test"), true);
  assert.equal(foreground.notices.length, 1);
  assert.equal(foreground.payloads("deliver").at(-1).channel, "browser");
});

test("渠道回退：两个原生桥都抛错时退回浏览器通知，权限快照跟着刷新", () => {
  const harness = createHarness({
    currentId: "current",
    bridges: "throwing",
    statuses: new Map([stopped("current")])
  });

  // 有原生桥时能力就是 native（不读浏览器权限）。
  assert.equal(harness.model.getSnapshot().notificationPermission, "native");

  assert.equal(harness.model.sendTestNotification(), true);
  // 两个桥都被尝试过（顺序是投递层的契约），最后用浏览器通知投了出去。
  assert.deepEqual(harness.bridgeAttempts.map((attempt) => attempt.channel), ["shell", "webview"]);
  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "DSH reminder test");
  // 只有走到浏览器那一步才读得到权限：模型的状态跟着投递结果刷新。
  assert.equal(harness.model.getSnapshot().notificationPermission, "granted");
});

test("语言与注册：通知文案跟随官方 locale 词典，设置区注册为插件配置 section", () => {
  const harness = createHarness({
    currentId: "current",
    localeLanguage: "zh",
    statuses: new Map([running("background")])
  });

  harness.setStatuses(new Map([stopped("background", { completionUnread: true })]));

  assert.equal(harness.notices.length, 1);
  assert.equal(harness.notices[0].title, "会话已中断或停止");
  assert.equal(harness.notices[0].options.body, "Background session：会话已停止，但无法确定原因");

  // 设置区是插件配置页的 section（不是常规设置页的一行），标签与通知文案同源（同一个 `t`）。
  assert.equal(harness.registration.meta.name, "settings.section");
  assert.equal(harness.registration.meta.id, "@cningan/dsh-session-status");
  assert.equal(harness.registration.meta.order, 30);
  assert.equal(harness.registration.meta.label(), "会话提醒");
});
