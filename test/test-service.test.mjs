/**
 * 测试服务直测（`lib/client/test-service.mjs`）：不模拟浏览器，只注入替身。
 *
 * 断言四件事：
 *   1. **前台覆盖的闸门**：只认 `auto` / `foreground` / `background` 三态，其余取值一律按
 *      `auto`（默认行为因此与没有本服务时一致）；
 *   2. **覆盖只落在 `background` 这一位**：`auto` 原样返回同一个对象（判定不变），另外两态
 *      替换结论、原样带走宿主证据（`visibility` / `focused`）；
 *   3. **服务面就是契约的四个方法**：`dev/` 插件拿到的是这四个键，不是装配层的内部
 *      协作者（权限请求 `requestPermission` 不在 Hook 面上）；
 *   4. **写路径的归一化**：`setForegroundOverride` 与 `deliverAdHoc` 交到模型手上的都是
 *      归一化之后的取值。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ADHOC_KEY_PREFIX,
  FOREGROUND_MODES,
  TEST_SERVICE_NAME,
  createTestStatusService,
  foregroundModeOf,
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

test("服务面就是契约的四个方法：装配层的内部协作者不泄漏", () => {
  const service = createTestStatusService(createModelDouble());

  assert.deepEqual(Object.keys(service), ["setForegroundOverride", "getSnapshot", "subscribe", "deliverAdHoc"]);
  for (const key of ["requestPermission", "sendTestNotification", "notify"]) {
    assert.equal(Object.hasOwn(service, key), false, `服务不应暴露 ${key}`);
  }
});

test("四个方法都转发给模型，且写路径交出去的是归一化后的取值", () => {
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
    ["deliverAdHoc", "test"]
  ]);
});
