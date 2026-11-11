/**
 * 诊断上报 sink 直测（`lib/client/diagnostics-sink.mjs`）：不模拟浏览器，只注入假 fetch
 * 与假时钟。断言四件事：
 *   1. 事件名常量表是六类事件的单一来源（词表本身定义在 `lib/diagnostics-contract.mjs`，
 *      这里断言的是 sink 转出的那一份）；
 *   2. 六类事件的**落盘形状**（逐字节，含字段顺序）与读方 `scripts/check-diagnostics.mjs`
 *      解析的 `{"at","event","payload","build"}` 一致（`build` 是唯一的新增字段，
 *      标明产生它的构建；不在构建产物里跑时按正式构建算）；
 *   3. `fetch` 缺失、抛错、返回非 Promise 或拒绝时**绝不抛**（上报失败不影响提醒行为）；
 *   4. 边沿记录通道：判定核心的只读边沿事实（`decider.edges`）→ 与既有 JSONL 同形的记录，
 *      包括「观察到停止边沿但没有提醒」（抑制/静默/显式移除）那一类——读方的 FAIL 文案
 *      正是为它写的。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { DIAGNOSTIC_EVENTS, createDiagnosticsSink, diagnosticsEndpoint } from "../lib/client/diagnostics-sink.mjs";
import { CLIENT_BUILDS } from "../lib/diagnostics-contract.mjs";
import { createDecider } from "../lib/core/decide.mjs";
import { analyze, parseRecords } from "../scripts/check-diagnostics.mjs";

const PLUGIN_ID = "dsh-session-reminder";
const ENDPOINT = "/plugins/dsh-session-reminder/diagnostics";
const AT = "2026-09-26T10:20:30.000Z";
const NOW = () => new Date(AT);
const CLIENT_PREFIX = "client:";
/** 不在构建产物里跑（Node 直测）时 sink 报的构建：正式产物。 */
const BUILD = CLIENT_BUILDS.PRODUCTION;

/** 假 fetch + 假时钟的 sink：收下每次调用的路径与请求体（逐字节比较用）。 */
function recorder() {
  const posts = [];
  const sink = createDiagnosticsSink({
    fetch: (path, options) => {
      posts.push({ path, options });
      return Promise.resolve({ ok: true });
    },
    pluginId: PLUGIN_ID,
    now: NOW
  });
  return { posts, sink };
}

function bodies(posts) {
  return posts.map((post) => post.options.body);
}

/** 一行领域会话；默认是「列表里有、空闲、无等待、未读为假」。 */
function session(id, overrides = {}) {
  return {
    id,
    title: `${id} title`,
    running: false,
    pending: null,
    unread: false,
    inList: true,
    ...overrides
  };
}

test("the event-name table is the single source for the six reported events", () => {
  assert.ok(Object.isFrozen(DIAGNOSTIC_EVENTS));
  assert.deepEqual(Object.keys(DIAGNOSTIC_EVENTS).sort(),
    ["ATTACH", "DELIVER", "EDGE", "PLATFORM", "SOURCE_SHAPE", "STATUS"]);
  assert.deepEqual(Object.values(DIAGNOSTIC_EVENTS).sort(),
    ["attach", "deliver", "edge", "platform", "source-shape", "status"]);
  // Host 落盘时才加 `client:` 前缀：这里只有裸名。
  for (const name of Object.values(DIAGNOSTIC_EVENTS)) {
    assert.doesNotMatch(name, /^client:/);
  }
});

test("derives the diagnostics route the Host registers, and lets it be overridden", () => {
  assert.equal(diagnosticsEndpoint(PLUGIN_ID), ENDPOINT);
  assert.equal(diagnosticsEndpoint("dsh-session-reminder"), ENDPOINT);
  assert.equal(diagnosticsEndpoint(), ENDPOINT);
  assert.equal(diagnosticsEndpoint(""), ENDPOINT);

  const posts = [];
  const sink = createDiagnosticsSink({
    fetch: (path) => { posts.push(path); return Promise.resolve(); },
    endpoint: "/plugins/other/diagnostics",
    now: NOW
  });
  sink.report(DIAGNOSTIC_EVENTS.ATTACH, {});
  assert.deepEqual(posts, ["/plugins/other/diagnostics"]);
});

test("posts each of the six events in the wire shape the reader parses", () => {
  const cases = [
    [DIAGNOSTIC_EVENTS.ATTACH, { hasSessionsList: true, browserPermission: "granted" }],
    [DIAGNOSTIC_EVENTS.STATUS, { statusEntries: 1, currentId: "a", runs: [] }],
    [DIAGNOSTIC_EVENTS.EDGE, { sessionId: "a", kind: "terminal", suppressed: null }],
    [DIAGNOSTIC_EVENTS.DELIVER, { key: "terminal:a:1", channel: "browser", delivered: true }],
    [DIAGNOSTIC_EVENTS.PLATFORM, { key: "terminal:a:1", event: "onshow", error: null }],
    [DIAGNOSTIC_EVENTS.SOURCE_SHAPE, { stage: "list", byIdType: "undefined", snapshotKeys: null }]
  ];

  const { posts, sink } = recorder();
  for (const [event, payload] of cases) sink.report(event, payload);

  assert.equal(posts.length, cases.length);
  for (const [index, [event, payload]] of cases.entries()) {
    const post = posts[index];
    assert.equal(post.path, ENDPOINT);
    assert.equal(post.options.method, "POST");
    assert.equal(post.options.headers["content-type"], "application/json");
    assert.equal(post.options.keepalive, true);
    // 逐字节：字段名、字段顺序与取值都必须与既有 JSONL 一致；`build` 是唯一新增的字段，
    // 且在 envelope 末尾（新增字段不改变既有字段的字节）。
    assert.equal(post.options.body,
      `{"at":"${AT}","event":"${event}","payload":${JSON.stringify(payload)},"build":"${BUILD}"}`);
    assert.deepEqual(JSON.parse(post.options.body), { at: AT, event, payload, build: BUILD });
  }
});

test("stamps which instrument produced the record, and lets a caller override it", () => {
  // 不在构建产物里跑（Node 直测）：没有 __DEBUG__，按正式构建算——这是诚实的默认。
  const { posts, sink } = recorder();
  sink.report(DIAGNOSTIC_EVENTS.ATTACH, {});
  assert.equal(JSON.parse(posts[0].options.body).build, CLIENT_BUILDS.PRODUCTION);

  // 显式注入时以注入值为准（构建产物里由 __DEBUG__ 决定，见 test/model-surface.test.mjs）。
  const injected = [];
  const debugSink = createDiagnosticsSink({
    fetch: (path, options) => { injected.push(JSON.parse(options.body)); return Promise.resolve(); },
    now: NOW,
    build: CLIENT_BUILDS.DEBUG
  });
  debugSink.report(DIAGNOSTIC_EVENTS.ATTACH, {});
  assert.equal(injected[0].build, CLIENT_BUILDS.DEBUG);
  // 字段顺序：at → event → payload → build（envelope 的规范顺序，由契约 module 造）。
  assert.deepEqual(Object.keys(injected[0]), ["at", "event", "payload", "build"]);
});

test("falls back to the global fetch lazily when none is injected", () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (path, options) => {
    calls.push({ path, options });
    return Promise.resolve({ ok: true });
  };
  try {
    // 没有注入 fetch：用当时的全局 fetch（浏览器/WebView 里的那个）。
    const sink = createDiagnosticsSink({ pluginId: PLUGIN_ID, now: NOW });
    sink.report(DIAGNOSTIC_EVENTS.ATTACH, { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].path, ENDPOINT);
    assert.equal(JSON.parse(calls[0].options.body).event, DIAGNOSTIC_EVENTS.ATTACH);
  } finally {
    globalThis.fetch = original;
  }
});

test("never throws when fetch is missing, throws, rejects, or returns a non-promise", async () => {
  // 传 null 表示「没有可用的 fetch」：静默不报，不抛。
  const none = createDiagnosticsSink({ fetch: null, pluginId: PLUGIN_ID, now: NOW });
  assert.doesNotThrow(() => none.report(DIAGNOSTIC_EVENTS.ATTACH, {}));
  assert.doesNotThrow(() => none.reportEdge({ sessionId: "a", kind: "terminal" }));

  // 同步抛错。
  const throwing = createDiagnosticsSink({ fetch: () => { throw new Error("fetch down"); }, now: NOW });
  assert.doesNotThrow(() => throwing.report(DIAGNOSTIC_EVENTS.DELIVER, { key: "k" }));

  // 拒绝的 Promise：不能变成调用点看得见的失败。
  const rejecting = createDiagnosticsSink({ fetch: () => Promise.reject(new Error("network down")), now: NOW });
  assert.doesNotThrow(() => rejecting.report(DIAGNOSTIC_EVENTS.STATUS, { statusEntries: 0 }));

  // 非 Promise 返回值（假替身常见）：同样不抛。
  const bare = createDiagnosticsSink({ fetch: () => undefined, now: NOW });
  assert.doesNotThrow(() => bare.report(DIAGNOSTIC_EVENTS.PLATFORM, { key: "k", event: "onshow" }));

  // 时钟抛错也只是一次没上报。
  const badClock = createDiagnosticsSink({ fetch: () => Promise.resolve(), now: () => { throw new Error("no clock"); } });
  assert.doesNotThrow(() => badClock.report(DIAGNOSTIC_EVENTS.ATTACH, {}));

  // 让被拒绝的 Promise 走完一轮微任务：没有未处理拒绝才算真的「不影响提醒行为」。
  await new Promise((resolve) => { setTimeout(resolve, 0); });
});

test("reports an edge fact as the exact record the reader already parses", () => {
  const { posts, sink } = recorder();

  // ① pending 边沿：历史形状只有 sessionId/kind/interactionKind（没有 suppressed/isCurrent）。
  const pending = sink.reportEdge({ sessionId: "a", kind: "pending", noticeIndex: 0, interactionKind: "approval" });
  assert.equal(JSON.stringify(pending), '{"sessionId":"a","kind":"pending","interactionKind":"approval"}');

  // ② 被抑制的停止边沿（列表行不在）：带抑制原因，不带 hasTurnEndReason。
  const suppressed = sink.reportEdge({
    sessionId: "b", kind: "terminal", noticeIndex: null, suppressed: "missing-list-row", isCurrent: true
  });
  assert.equal(JSON.stringify(suppressed),
    '{"sessionId":"b","kind":"terminal","suppressed":"missing-list-row","isCurrent":true}');

  // ③ 已提醒的停止边沿：suppressed 为 null，带是否选中会话与有无 turn/end 原因。
  const notified = sink.reportEdge({
    sessionId: "c", kind: "terminal", noticeIndex: 0, suppressed: null, isCurrent: false, hasTurnEndReason: true
  });
  assert.equal(JSON.stringify(notified),
    '{"sessionId":"c","kind":"terminal","suppressed":null,"isCurrent":false,"hasTurnEndReason":true}');

  // ④ 静默/显式移除的停止边沿：形状与「已提醒」相同（读方的 FAIL 文案正是为它写的）。
  const silent = sink.reportEdge({
    sessionId: "d", kind: "terminal", noticeIndex: null, suppressed: null, isCurrent: true, hasTurnEndReason: false
  });
  assert.equal(JSON.stringify(silent),
    '{"sessionId":"d","kind":"terminal","suppressed":null,"isCurrent":true,"hasTurnEndReason":false}');

  assert.deepEqual(bodies(posts).map((body) => JSON.parse(body).event),
    [DIAGNOSTIC_EVENTS.EDGE, DIAGNOSTIC_EVENTS.EDGE, DIAGNOSTIC_EVENTS.EDGE, DIAGNOSTIC_EVENTS.EDGE]);
  // 返回的就是上报出去的那一条记录（装配层据此并进内存诊断）。
  assert.deepEqual(JSON.parse(posts[0].options.body).payload, pending);
});

test("turns the decider's read-only edge facts into records, including observed-but-not-notified edges", () => {
  const { posts, sink } = recorder();
  const decider = createDecider();

  // 基线：a、b、c 都在跑，谁都没有等待。
  decider.observe({
    sessions: [session("a", { running: true }), session("b", { running: true }), session("c", { running: true })],
    currentId: "a"
  });
  assert.deepEqual(decider.edges, []);

  // 一轮里混合三类边沿：a 正常停止（提醒）、c 出现新等待对象（提醒）、b 列表行不在（抑制，无提醒）。
  const notices = decider.observe({
    sessions: [
      session("a", { running: false }),
      session("b", { running: false, inList: false }),
      session("c", { running: true, pending: { kind: "approval" } })
    ],
    currentId: "a",
    current: { removed: false, turnEnd: { kind: "completed" }, detail: undefined }
  });
  assert.deepEqual(notices.map((notice) => [notice.sessionId, notice.kind]),
    [["a", "terminal"], ["c", "pending"]]);

  // 边沿事实的顺序：已产出提醒的在前（与 notices 同序），仅观察到的在后。
  assert.deepEqual(decider.edges.map((edge) => [edge.sessionId, edge.noticeIndex]),
    [["a", 0], ["c", 1], ["b", null]]);

  const records = decider.edges.map((edge) => sink.reportEdge(edge));
  assert.deepEqual(records, [
    { sessionId: "a", kind: "terminal", suppressed: null, isCurrent: true, hasTurnEndReason: true },
    { sessionId: "c", kind: "pending", interactionKind: "approval" },
    { sessionId: "b", kind: "terminal", suppressed: "missing-list-row", isCurrent: false }
  ]);
  assert.equal(bodies(posts).length, 3);
  // 落盘记录里没有边的「事实」字段（noticeIndex 等）：线格式仍与历史一致（外加 build）。
  assert.equal(bodies(posts)[0], `{"at":"${AT}","event":"edge","payload":{"sessionId":"a","kind":"terminal","suppressed":null,"isCurrent":true,"hasTurnEndReason":true},"build":"${BUILD}"}`);
  assert.equal(bodies(posts)[1], `{"at":"${AT}","event":"edge","payload":{"sessionId":"c","kind":"pending","interactionKind":"approval"},"build":"${BUILD}"}`);
  assert.equal(bodies(posts)[2], `{"at":"${AT}","event":"edge","payload":{"sessionId":"b","kind":"terminal","suppressed":"missing-list-row","isCurrent":false},"build":"${BUILD}"}`);
});

test("the suppression channel is what feeds the reader's suppressed-edge verdict", () => {
  const { posts, sink } = recorder();
  const decider = createDecider();

  decider.observe({ sessions: [session("a", { running: true })], currentId: "current" });
  const notices = decider.observe({
    sessions: [session("a", { running: false, inList: false })],
    currentId: "current"
  });

  // 没有提醒可投——这条边沿只存在于只读事实里。
  assert.deepEqual(notices, []);
  assert.equal(decider.edges[0].noticeIndex, null);
  for (const edge of decider.edges) sink.reportEdge(edge);

  // 读方拿到的是「边沿被抑制」，而不是「还没观察到边沿」。
  const jsonl = posts
    .map((post) => JSON.parse(post.options.body))
    .map((record) => JSON.stringify({ ...record, event: `${CLIENT_PREFIX}${record.event}` }))
    .join("\n");
  const verdict = analyze(parseRecords(jsonl));
  assert.equal(verdict.label, "FAIL");
  assert.equal(verdict.code, 1);
  assert.match(verdict.message, /停止边沿被抑制/);
});
