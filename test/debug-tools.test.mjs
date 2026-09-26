/**
 * 调试工具直测（`lib/client/debug-tools.mjs`）：不模拟浏览器，只注入替身——
 * 调试连接口（`link`，model 填 `deliverAdHoc`/`notify` 的那一端）、假 `t`、假 `h`、假定时器。
 *
 * 断言三件事：
 *   1. 探针经**注入的投递出口**投递，载荷与既有实现同形（键前缀 + kind + 文案），
 *      连发与延迟都只是它的组合（定时器可注入，所以不必等真实时间）；
 *   2. 测试模式开关写在连接口上（model 读它跳过前台抑制）并触发一次重渲染；
 *   3. 设置区的调试部分（诊断文本块 + 诊断工具行）由本 module 渲染：`canTest` 为假时
 *      只有诊断块、没有工具行，正式构建里设置区拿不到它（见 test/settings.test.mjs）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { createDebugTools, PROBE_KEY_PREFIX } from "../lib/client/debug-tools.mjs";

/** 假 React `createElement`：元素树就是普通对象，足以断言结构与文案。 */
const h = (type, props, ...children) => ({ type, props: { ...props, children } });

/** 假 locale 绑定：直接把键标出来，断言「文案来自注入的 t」而不是硬编码。 */
const t = (key) => `t:${key}`;

/** 假连接口：收下 `deliverAdHoc` 的载荷、数 `notify` 次数、持有 `testMode`。 */
/** 假 `h` 的 children 永远是数组；取第一个子节点（按钮文案、诊断行文本）。 */
function firstChild(node) {
  const children = node.props?.children;
  return Array.isArray(children) ? children[0] : children;
}

/** 诊断块的四个行文本：块里只有一个子节点——那个字符串数组。 */
function lineTexts(block) {
  return block.props.children.flat(1).map((node) => firstChild(node));
}

function createLink() {
  const delivered = [];
  const link = {
    testMode: false,
    delivered,
    notified: 0,
    deliverAdHoc(notice) {
      delivered.push(notice);
      return true;
    },
    notify() {
      link.notified += 1;
    }
  };
  return link;
}

/** 假定时器：把回调排进队列，测试自己决定何时跑（不发真实的 2 秒/10 秒等待）。 */
function createTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, delay) {
      scheduled.push({ fn, delay });
      return scheduled.length;
    },
    runAll() {
      let guard = 0;
      while (scheduled.length > 0) {
        if (guard++ > 20) throw new Error("timer queue did not drain");
        scheduled.shift().fn();
      }
    }
  };
}

function createTools() {
  const link = createLink();
  const timers = createTimers();
  const tools = createDebugTools({ link, t, h, setTimeout: timers.setTimeout });
  return { link, timers, tools };
}

const PROBE_NOTICE = (kind) => ({
  keyPrefix: PROBE_KEY_PREFIX,
  kind,
  title: kind === "test" ? "t:testNotificationTitle" : "t:interrupted",
  message: "t:testNotificationMessage"
});

test("探针经注入的投递出口投递，键前缀与文案与自检同源", () => {
  const { link, tools } = createTools();

  assert.equal(tools.sendProbe(), true);
  assert.equal(tools.sendProbe("test"), true);
  assert.equal(tools.sendProbe("interrupted"), true);

  assert.deepEqual(link.delivered, [
    PROBE_NOTICE("test"),
    PROBE_NOTICE("test"),
    PROBE_NOTICE("interrupted")
  ]);
  // 键本身由 model 拼（前缀由这里给）：探针用 test-probe，与设置页自检的 test: 分开。
  assert.equal(PROBE_KEY_PREFIX, "test-probe");
});

test("测试模式开关写在连接口上（model 据此跳过前台抑制）并触发一次重渲染", () => {
  const { link, tools } = createTools();

  assert.equal(tools.isTestMode(), false);
  assert.equal(tools.setTestMode(true), true);
  assert.equal(link.testMode, true);
  assert.equal(link.notified, 1);
  assert.equal(tools.isTestMode(), true);

  // 只有严格 true 才算打开（与既有 setTestMode 的取值口径一致）。
  assert.equal(tools.setTestMode("yes"), false);
  assert.equal(link.testMode, false);
  assert.equal(link.notified, 2);
});

test("连发探针：同参数连投 count 条，间隔逐次交给注入的定时器", () => {
  const { link, timers, tools } = createTools();

  assert.equal(tools.sendProbeBurst("test", 3), 3);
  assert.equal(link.delivered.length, 1);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 2000);

  timers.runAll();
  assert.equal(link.delivered.length, 3);
  assert.deepEqual(link.delivered, [PROBE_NOTICE("test"), PROBE_NOTICE("test"), PROBE_NOTICE("test")]);
});

test("延迟探针：到点才投一条，延迟与 kind 都由调用方给", () => {
  const { link, timers, tools } = createTools();

  tools.sendDelayedProbe(10000, "interrupted");
  assert.equal(link.delivered.length, 0);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delay, 10000);

  timers.runAll();
  assert.deepEqual(link.delivered, [PROBE_NOTICE("interrupted")]);
});

test("诊断文本块：状态源/边沿/投递/当前页面四行，缺数据时给占位而不是崩", () => {
  const { tools } = createTools();
  const empty = tools.renderExtras({ snapshot: { diagnostics: {} }, canTest: false, testResult: "", setTestResult() {} });
  const lines = lineTexts(empty[0]);

  assert.equal(lines.length, 4);
  assert.match(lines[0], /^诊断·状态源 \? 条/);
  assert.equal(lines[1], "诊断·边沿 尚未观察到");
  assert.equal(lines[2], "诊断·投递 尚无尝试");
  // Node 直测里没有 document：页面那两行给 `?`，不抛。
  assert.equal(lines[3], "诊断·当前页面 ?；失焦判定 否");

  const filled = tools.renderExtras({
    snapshot: {
      diagnostics: {
        status: { statusEntries: 2, currentInStatuses: true, listHandlesCurrent: false, runs: [{ running: true }, { running: false }] },
        edge: { kind: "terminal", suppressed: "missing-list-row" },
        deliver: {
          at: "12:00:00",
          kind: "interrupted",
          channel: "suppressed-foreground",
          delivered: false,
          background: false,
          activation: { everActive: true },
          platform: null
        }
      }
    },
    canTest: false,
    testResult: "",
    setTestResult() {}
  });
  const filledLines = lineTexts(filled[0]);
  assert.match(filledLines[0], /状态源 2 条；当前会话在状态 是；列表含当前 否；运行中 1/);
  assert.equal(filledLines[1], "诊断·最近边沿 terminal（抑制：missing-list-row）");
  assert.match(filledLines[2], /最近投递 12:00:00 interrupted\/suppressed-foreground；已投递 否；失焦判定 否；用户激活 曾有；平台反馈 （无事件）/);
  // 诊断块本身是独立整行（不是被按钮挤压的窄列）。
  assert.equal(empty[0].type, "div");
  assert.equal(empty[0].props.className, "dshss-settings-diagnostics");
});

test("只有已经能投递（canTest）时才给诊断工具行，四个按钮固定顺序且探针可达", () => {
  const { link, tools } = createTools();

  const blocked = tools.renderExtras({ snapshot: { diagnostics: {}, testMode: false }, canTest: false, testResult: "", setTestResult() {} });
  assert.equal(blocked.length, 2);
  assert.ok(blocked[0] !== null);
  assert.equal(blocked[1], null);

  const results = [];
  const allowed = tools.renderExtras({
    snapshot: { diagnostics: {}, testMode: false },
    canTest: true,
    testResult: "",
    setTestResult: (value) => results.push(value)
  });
  const row = allowed[1];
  assert.equal(row.props.className, "dshss-settings-tools");
  const buttons = row.props.children;
  assert.deepEqual(buttons.map((button) => firstChild(button)), [
    "t:testMode",
    "t:probeNotification",
    "t:probeInterrupted",
    "t:probeBurst"
  ]);

  // ① 测试模式开关：写连接口（model 读它决定前台否决）。
  buttons[0].props.onClick();
  assert.equal(link.testMode, true);
  // ② test 探针与 ③ interrupted 探针：立即投递，并把设置区的提示状态改成"已投递"。
  buttons[1].props.onClick();
  buttons[2].props.onClick();
  assert.deepEqual(link.delivered, [PROBE_NOTICE("test"), PROBE_NOTICE("interrupted")]);
  // ④ 连发探针：一次点击排 3 条。
  buttons[3].props.onClick();
  assert.equal(link.delivered.length, 3);
  // 三个探针按钮共用同一处提示状态（切换开关不写它）。
  assert.deepEqual(results, ["probe-fired", "probe-fired", "probe-fired"]);
});

test("测试模式开着时，工具行给出「已开启」的按钮文案", () => {
  const { tools } = createTools();
  const extras = tools.renderExtras({
    snapshot: { diagnostics: {}, testMode: true },
    canTest: true,
    testResult: "probe-fired",
    setTestResult() {}
  });
  const labels = extras[1].props.children.map((button) => firstChild(button));
  // 三个探针按钮共用同一处提示状态：刚投过就都显示"探针已投递"。
  assert.deepEqual(labels, ["t:testModeOn", "t:probeFired", "t:probeFired", "t:probeFired"]);
});
