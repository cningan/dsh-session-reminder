/**
 * 测试服务直测（`lib/client/test-service.mjs`）：不模拟浏览器，只注入替身。
 *
 * 断言五件事：
 *   1. **前台覆盖的闸门**：只认 `auto` / `foreground` / `background` 三态，其余取值一律按
 *      `auto`（默认行为因此与没有本服务时一致）；
 *   2. **覆盖只落在 `background` 这一位**：`auto` 原样返回同一个对象（判定不变），另外两态
 *      替换结论、原样带走宿主证据（`visibility` / `focused`）；
 *   3. **服务面就是契约的五个方法**：`dev/` 插件拿到的是这五个键，不是装配层的内部
 *      协作者（权限请求 `requestPermission` 不在 Hook 面上）；
 *   4. **写路径的归一化**：`setForegroundOverride` / `deliverAdHoc` / `deliverSample`
 *      交到模型手上的都是归一化之后的取值；
 *   5. **可模拟的原因就是分类词表本身**：`SAMPLE_REASONS` 从 `core/classify` 派生，
 *      词表外一律按 `interrupted`——面板给出的按钮因此不可能指向不存在的原因。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { TERMINAL_REASONS } from "../lib/core/classify.mjs";
import {
  ADHOC_KEY_PREFIX,
  FOREGROUND_MODES,
  SAMPLE_DETAIL,
  SAMPLE_REASONS,
  TEST_SERVICE_NAME,
  createTestStatusService,
  foregroundModeOf,
  sampleReasonOf,
  withForegroundMode
} from "../lib/client/test-service.mjs";

/** 假模型：记下每一次调用与实参，便于断言「服务把什么交给了模型」。 */
function createModelDouble() {
  const calls = [];
  const model = {
    calls,
    setForegroundOverride(mode) {
      calls.push(["setForegroundOverride", mode]);
      return mode;
    },
    getSnapshot() {
      calls.push(["getSnapshot"]);
      return { marker: "snapshot" };
    },
    subscribe(listener) {
      calls.push(["subscribe", listener]);
      return () => calls.push(["unsubscribe", listener]);
    },
    deliverAdHoc(kind) {
      calls.push(["deliverAdHoc", kind]);
      return kind === "interrupted" ? "delivered-interrupted" : "delivered-test";
    },
    deliverSample(reason) {
      calls.push(["deliverSample", reason]);
      return reason === "completed" ? "delivered-completed" : "delivered-sample";
    },
    setDevToolsEnabled(enabled) {
      calls.push(["setDevToolsEnabled", enabled]);
      return enabled;
    }
  };
  return model;
}

const PAGE = Object.freeze({ visibility: "visible", focused: true, background: false });

test("服务名与前台覆盖词表是固定契约", () => {
  assert.equal(TEST_SERVICE_NAME, "sessionStatusTest");
  assert.deepEqual([...FOREGROUND_MODES], ["auto", "foreground", "background"]);
  // 键前缀沿用既有 JSONL 的探针前缀：历史记录仍读得通。
  assert.equal(ADHOC_KEY_PREFIX, "test-probe");
});

test("前台覆盖的闸门：只认三态，其余按 auto", () => {
  for (const mode of FOREGROUND_MODES) assert.equal(foregroundModeOf(mode), mode);

  for (const value of [undefined, null, "", "FOREGROUND", "foreground ", 0, 1, true, {}, ["auto"]]) {
    assert.equal(foregroundModeOf(value), "auto", `${JSON.stringify(value)} 应退化为 auto`);
  }
});

test("覆盖只落在 background 这一位：auto 原样返回，另外两态只改结论", () => {
  // auto 时连对象都不换（判定路径上零开销、零分叉）。
  assert.equal(withForegroundMode(PAGE, "auto"), PAGE);
  // 闸门之外的取值同样按 auto。
  assert.equal(withForegroundMode(PAGE, "whatever"), PAGE);

  // foreground：结论说「在前台」（不抑制），证据仍是宿主原值。
  assert.deepEqual(withForegroundMode(PAGE, "foreground"), {
    visibility: "visible",
    focused: true,
    background: false
  });
  // background：强制失焦。宿主说前台时也照样覆盖（这正是面板双向验证要的能力）。
  assert.deepEqual(withForegroundMode(PAGE, "background"), {
    visibility: "visible",
    focused: true,
    background: true
  });

  // 没有宿主页面（Node/非浏览器）：覆盖照旧只动结论。
  const noDocument = { visibility: null, focused: null, background: false };
  assert.deepEqual(withForegroundMode(noDocument, "background"), { visibility: null, focused: null, background: true });
  assert.equal(withForegroundMode(noDocument, "auto"), noDocument);
});

test("服务面就是契约的六个方法：装配层的内部协作者不泄漏", () => {
  const service = createTestStatusService(createModelDouble());

  assert.deepEqual(Object.keys(service), [
    "setForegroundOverride",
    "getSnapshot",
    "subscribe",
    "deliverAdHoc",
    "deliverSample",
    "setDevToolsEnabled"
  ]);
  for (const key of ["requestPermission", "sendTestNotification", "notify"]) {
    assert.equal(Object.hasOwn(service, key), false, `服务不应暴露 ${key}`);
  }
});

test("可模拟的原因就是分类词表本身，词表外按 interrupted", () => {
  // 从 core/classify 派生而不是另抄一份：新增原因时面板与文案不会各说各话。
  assert.deepEqual([...SAMPLE_REASONS], [...TERMINAL_REASONS]);

  for (const reason of SAMPLE_REASONS) assert.equal(sampleReasonOf(reason), reason);
  for (const value of [undefined, null, "", "COMPLETED", "completed ", 0, true, {}, ["completed"]]) {
    assert.equal(sampleReasonOf(value), "interrupted", `${JSON.stringify(value)} 应退化为 interrupted`);
  }

  // 样例细节只给真有技术细节的那几条；其余原因本来就没有细节，正文只剩会话标题。
  assert.deepEqual(Object.keys(SAMPLE_DETAIL).sort(), ["aborted-hook", "agent-error", "error", "prompt-error"]);
  for (const reason of Object.keys(SAMPLE_DETAIL)) {
    assert.ok(SAMPLE_REASONS.includes(reason), `${reason} 必须是分类词表里的原因`);
  }
});

test("五个方法都转发给模型，且写路径交出去的是归一化后的取值", () => {
  const model = createModelDouble();
  const service = createTestStatusService(model);

  assert.equal(service.setForegroundOverride("background"), "background");
  assert.equal(service.setForegroundOverride("nonsense"), "auto");
  assert.equal(service.setForegroundOverride(undefined), "auto");

  assert.deepEqual(service.getSnapshot(), { marker: "snapshot" });

  const listener = () => {};
  service.subscribe(listener);
  const off = service.subscribe(listener);
  assert.equal(typeof off, "function");

  assert.equal(service.deliverAdHoc(), "delivered-test");
  assert.equal(service.deliverAdHoc("test"), "delivered-test");
  assert.equal(service.deliverAdHoc("interrupted"), "delivered-interrupted");
  // `kind` 只认 test / interrupted，其余按 test（键与文案因此不会出现野值）。
  assert.equal(service.deliverAdHoc("probe"), "delivered-test");

  assert.equal(service.deliverSample("completed"), "delivered-completed");
  // reason 只认分类词表，其余按 interrupted（键与文案因此不会出现野值）。
  assert.equal(service.deliverSample("nonsense"), "delivered-sample");
  assert.equal(service.deliverSample(undefined), "delivered-sample");

  // 总开关：只有严格 true 才算打开（与前台覆盖"只认三态"同一口径）。
  assert.equal(service.setDevToolsEnabled(true), true);
  assert.equal(service.setDevToolsEnabled("yes"), false);

  assert.deepEqual(model.calls, [
    ["setForegroundOverride", "background"],
    ["setForegroundOverride", "auto"],
    ["setForegroundOverride", "auto"],
    ["getSnapshot"],
    ["subscribe", listener],
    ["subscribe", listener],
    ["deliverAdHoc", "test"],
    ["deliverAdHoc", "test"],
    ["deliverAdHoc", "interrupted"],
    ["deliverAdHoc", "test"],
    ["deliverSample", "completed"],
    ["deliverSample", "interrupted"],
    ["deliverSample", "interrupted"],
    ["setDevToolsEnabled", true],
    ["setDevToolsEnabled", false]
  ]);
});
