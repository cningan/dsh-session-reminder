/**
 * 面板直测（假服务 + 假 React，不模拟浏览器）：
 *
 *   1. 一眼看得出是开发用面板（标题里写明 DEV），且诊断**恰好 4 行**、顺序固定、
 *      内容按快照渲染；
 *   2. 三态开关把对应 mode 交给 `setForegroundOverride`（默认「跟随真实」），且只改结论、
 *      不改写宿主证据；
 *   3. 探针按钮调用 `deliverAdHoc`（test / interrupted / 连发 ×3）并把结果显示出来；
 *   4. **强制前台时结果提示表明被抑制**——这是本面板存在的理由（双向验证）；
 *   5. `subscribe` 订阅/退订：状态变化驱动重渲染，卸载即退订；
 *   6. 快照 → 文案是纯函数，可以脱离 React 直测；
 *   7. 字典中英键集合一致、面板用到的键都有译文（界面不会出现 key 原文）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  PANEL_STYLE_TAG,
  SAMPLE_REASONS,
  createDebugPanel,
  describeDeliver,
  describeResult,
  describeSnapshot,
  installPanelStyle,
  toneOf
} from "../src/panel.mjs";
import { dictionaries } from "../src/strings.mjs";
import { TERMINAL_REASONS } from "../../../lib/core/classify.mjs";
import { createFakeService, createTranslator, mountWith, textOf } from "./harness.mjs";

function renderPanel(service, lang = "zh") {
  return mountWith((react) => createDebugPanel(react), { service, t: createTranslator(lang) });
}

/** 诊断 4 行：`{ key, text }`，按渲染顺序。 */
function rowsOf(panel) {
  return panel
    .findAll((node) => typeof node.props?.["data-row"] === "string")
    .map((node) => ({ key: node.props["data-row"], text: textOf(node) }));
}

function rowOf(panel, key) {
  return rowsOf(panel).find((row) => row.key === key);
}

function activeMode(panel) {
  const active = panel.findAll((node) => typeof node.props?.["data-mode"] === "string" && node.props.className.includes("is-active"));
  assert.equal(active.length, 1, "同时只能有一个覆盖模式处于选中态");
  return active[0].props["data-mode"];
}

function resultOf(panel) {
  const node = panel.findAll((item) => typeof item.props?.["data-tone"] === "string")[0];
  return node === undefined ? null : { tone: node.props["data-tone"], text: textOf(node) };
}

test("面板一眼看出是开发用，且诊断恰好 4 行（状态源 / 边沿 / 投递 / 当前页面）", () => {
  const service = createFakeService();
  const panel = renderPanel(service);

  assert.match(panel.text(), /DEV/);
  assert.match(panel.text(), /开发调试面板/);
  assert.match(panel.text(), /不在发布包里/);

  const rows = rowsOf(panel);
  assert.deepEqual(rows.map((row) => row.key), ["status", "edge", "deliver", "page"]);
  // 空快照：前 3 行都是「暂无」，第 4 行是宿主事实 + 失焦判定。
  assert.deepEqual(rows.slice(0, 3).map((row) => row.text), [
    "状态源摘要：（暂无）",
    "最近边沿：（暂无）",
    "最近投递：（暂无）"
  ]);
  assert.match(rows[3].text, /^当前页面 \/ 失焦判定：visible · 聚焦=是 · 失焦判定：前台 → 抑制投递/);
  assert.match(rows[3].text, /覆盖=跟随真实/);
});

test("诊断 4 行按快照渲染：状态源摘要、最近边沿（含被抑制）、最近投递、当前页面", () => {
  const service = createFakeService({ page: { visibility: "hidden", focused: false, background: true } });
  service.setDiagnostics({
    status: {
      statusEntries: 3,
      currentId: "s-1",
      currentInStatuses: true,
      listHandlesCurrent: false,
      runs: [
        { id: "s-1", running: true, pending: false, unread: false, inList: false },
        { id: "s-2", running: false, pending: false, unread: true, inList: true }
      ]
    },
    edge: { sessionId: "s-2", kind: "terminal", suppressed: "missing-list-row", isCurrent: false },
    deliver: {
      key: "test-probe:test:1",
      kind: "test",
      channel: "suppressed-foreground",
      delivered: false,
      background: true,
      at: "00:00:00",
      activation: false,
      foregroundOverride: "auto",
      platform: "close"
    }
  });
  const panel = renderPanel(service);

  assert.equal(rowOf(panel, "status").text, "状态源摘要：3 个会话 · 当前=s-1 · 状态/列表=是/否 · 运行中=1");
  assert.equal(rowOf(panel, "edge").text, "最近边沿：停止边沿 · 被抑制（列表行不在）· 当前会话=否 · 会话=s-2");
  assert.equal(
    rowOf(panel, "deliver").text,
    "最近投递：suppressed-foreground · 被前台抑制（未投递） · 页面=后台 · 投递时刻覆盖=跟随真实 · 平台=close"
  );
  assert.match(rowOf(panel, "page").text, /hidden · 聚焦=否 · 失焦判定：后台 → 允许投递 · 覆盖=跟随真实/);

  // 等待边沿走另一条模板（上游交互子类）。
  service.setDiagnostics({ edge: { sessionId: "s-1", kind: "pending", interactionKind: "approval", suppressed: null } });
  assert.equal(rowOf(panel, "edge").text, "最近边沿：等待边沿 · 交互=approval · 会话=s-1");
});

test("归属标注：摘要里出现子代理行时才追加，且能看出当前会话就是子代理（.scratch/session-status/issues/16-subagent-sessions-excluded.md）", () => {
  const runs = [
    { id: "s-1", running: true, pending: false, unread: false, inList: true },
    { id: "child-1", running: true, pending: false, unread: false, inList: true, origin: "subagent" }
  ];
  const service = createFakeService();
  service.setDiagnostics({
    status: { statusEntries: 3, currentId: "child-1", currentInStatuses: true, listHandlesCurrent: true, runs }
  });
  const panel = renderPanel(service);

  // 主插件只给子代理行打 `origin` 标注；面板把它照出来，并说明当前会话正在被归属过滤。
  assert.equal(
    rowOf(panel, "status").text,
    "状态源摘要：3 个会话 · 当前=child-1 · 状态/列表=是/是 · 运行中=2 · 子代理=1（不参与提醒） · "
      + "当前会话=子代理（不参与提醒）"
  );

  // 当前会话不是子代理（只是摘要窗口里有子代理行）：只说条数，不给「当前会话」那一句。
  service.setDiagnostics({
    status: { statusEntries: 3, currentId: "s-1", currentInStatuses: true, listHandlesCurrent: true, runs }
  });
  assert.equal(
    rowOf(panel, "status").text,
    "状态源摘要：3 个会话 · 当前=s-1 · 状态/列表=是/是 · 运行中=2 · 子代理=1（不参与提醒）"
  );

  // 摘要里没有子代理行：这一行与以前逐字符相同（既有断言即这一条），界面不凭空多话。
  service.setDiagnostics({
    status: { statusEntries: 3, currentId: "s-1", currentInStatuses: true, listHandlesCurrent: false, runs: runs.slice(0, 1) }
  });
  assert.equal(rowOf(panel, "status").text, "状态源摘要：3 个会话 · 当前=s-1 · 状态/列表=是/否 · 运行中=1");
});

test("三态开关：把对应 mode 交给 setForegroundOverride，默认跟随真实", () => {
  const service = createFakeService();
  const panel = renderPanel(service);

  const modes = panel.findAll((node) => typeof node.props?.["data-mode"] === "string");
  assert.deepEqual(modes.map((node) => node.props["data-mode"]), ["auto", "foreground", "background"]);
  assert.equal(activeMode(panel), "auto");
  assert.match(panel.text(), /当前覆盖：跟随真实 · 宿主证据：visible \/ 聚焦=是/);

  panel.clickAttr("data-mode", "foreground");
  assert.deepEqual(service.calls.setForegroundOverride, ["foreground"]);
  assert.equal(activeMode(panel), "foreground");
  // 覆盖只替换结论，不改写宿主证据（可见性/焦点仍是原值）。
  assert.deepEqual(service.getSnapshot().page, { visibility: "visible", focused: true, background: false });
  assert.equal(service.getSnapshot().foregroundOverride, "foreground");

  panel.clickAttr("data-mode", "background");
  assert.deepEqual(service.calls.setForegroundOverride, ["foreground", "background"]);
  assert.equal(activeMode(panel), "background");
  assert.deepEqual(service.getSnapshot().page, { visibility: "visible", focused: true, background: true });

  panel.clickAttr("data-mode", "auto");
  assert.deepEqual(service.calls.setForegroundOverride, ["foreground", "background", "auto"]);
  assert.equal(activeMode(panel), "auto");
  assert.match(panel.text(), /当前覆盖：跟随真实/);
});

test("探针按钮调用 deliverAdHoc 并显示结果（test / interrupted / 连发 ×3）", () => {
  const service = createFakeService({ page: { visibility: "hidden", focused: false, background: true } });
  const panel = renderPanel(service);

  assert.equal(resultOf(panel), null, "还没点过探针时不渲染结果块");
  panel.clickAttr("data-probe", "test");
  assert.deepEqual(service.calls.deliverAdHoc, ["test"]);
  assert.deepEqual(resultOf(panel), { tone: "delivered", text: "已弹出：测试提醒 真的投出了一条提醒。" });

  panel.clickAttr("data-probe", "interrupted");
  assert.deepEqual(service.calls.deliverAdHoc, ["test", "interrupted"]);
  assert.match(resultOf(panel).text, /^已弹出：中断提醒 /);

  panel.clickAttr("data-probe", "burst");
  assert.deepEqual(service.calls.deliverAdHoc, ["test", "interrupted", "test", "test", "test"]);
  assert.deepEqual(resultOf(panel), { tone: "delivered", text: "连发 ×3：3/3 条已弹出。" });
});

test("按原因模拟：11 条停止原因各一个按钮，点了就 deliverSample(reason)", () => {
  const service = createFakeService({ page: { visibility: "hidden", focused: false, background: true } });
  const panel = renderPanel(service);

  // 词表与主插件 core/classify 的 TERMINAL_REASONS 逐项、同序一致——面板不另立一份词表。
  assert.deepEqual(SAMPLE_REASONS.map((item) => item.reason), [...TERMINAL_REASONS]);
  const buttons = panel.findAll((node) => typeof node.props?.["data-sample"] === "string");
  assert.deepEqual(buttons.map((node) => node.props["data-sample"]), SAMPLE_REASONS.map((item) => item.reason));

  panel.clickAttr("data-sample", "completed");
  assert.deepEqual(service.calls.deliverSample, ["completed"]);
  assert.deepEqual(resultOf(panel), { tone: "delivered", text: "已投递：正常完成" });

  panel.clickAttr("data-sample", "error");
  assert.deepEqual(service.calls.deliverSample, ["completed", "error"]);
  assert.deepEqual(resultOf(panel), { tone: "delivered", text: "已投递：模型调用报错" });

  // 前台时同样被抑制：模拟走的是真实投递路径，不是面板自己弹一条。
  panel.clickAttr("data-mode", "foreground");
  panel.clickAttr("data-sample", "max-tokens");
  assert.deepEqual(resultOf(panel), { tone: "suppressed", text: "被前台抑制（未投递）：达到输出上限" });

  // 面板不复制通知文案：结果只报「投出去没有」，标题/正文由主插件按 reason 生成。
  assert.equal(describeResult({ kind: "sample", reason: "nonsense", delivered: 1, total: 1 }, createTranslator("zh")),
    "已投递：中断（原因未知）");
});

test("强制前台 + 探针：不弹，且结果提示与诊断都表明被前台抑制", () => {
  // 宿主说「页面在前台」（聚焦且可见）：这正是用户默认看到的状态。
  const service = createFakeService({ page: { visibility: "visible", focused: true, background: false } });
  const panel = renderPanel(service);

  panel.clickAttr("data-mode", "foreground");
  assert.equal(activeMode(panel), "foreground");
  panel.clickAttr("data-probe", "test");

  assert.deepEqual(service.calls.deliverAdHoc, ["test"]);
  assert.equal(service.getSnapshot().page.background, false, "强制前台时判定仍是前台");
  assert.deepEqual(resultOf(panel), {
    tone: "suppressed",
    text: "未弹出：测试提醒 被前台抑制、没有投递（诊断里已留下 suppressed-foreground 记录）。"
  });
  // 诊断里留下的是可区分的抑制记录，而不是「什么都没发生」。
  assert.match(rowOf(panel, "deliver").text, /suppressed-foreground · 被前台抑制（未投递）/);
  assert.match(rowOf(panel, "deliver").text, /投递时刻覆盖=强制前台/);

  // 同一个探针在「强制失焦」下就该弹——双向验证的另一半。
  panel.clickAttr("data-mode", "background");
  panel.clickAttr("data-probe", "test");
  assert.deepEqual(resultOf(panel), { tone: "delivered", text: "已弹出：测试提醒 真的投出了一条提醒。" });
  assert.match(rowOf(panel, "deliver").text, /browser · 已投递 · 页面=后台 · 投递时刻覆盖=强制失焦/);
});

test("反向：宿主失焦时强制前台同样抑制（探针不弹），跟随真实则弹", () => {
  const service = createFakeService({ page: { visibility: "hidden", focused: false, background: true } });
  const panel = renderPanel(service);

  // 跟随真实：宿主失焦 → 允许投递。
  panel.clickAttr("data-probe", "interrupted");
  assert.equal(resultOf(panel).tone, "delivered");

  // 强制前台：把「后台」这一位结论掀回前台，探针立刻被抑制。
  panel.clickAttr("data-mode", "foreground");
  panel.clickAttr("data-probe", "interrupted");
  assert.equal(resultOf(panel).tone, "suppressed");
  assert.equal(service.getSnapshot().page.background, false);
  // 证据仍是宿主原值：页面仍然隐藏、仍然失焦。
  assert.deepEqual(service.getSnapshot().page, { visibility: "hidden", focused: false, background: false });

  // 连发 ×3 也逐条服从同一个判定。
  panel.clickAttr("data-mode", "foreground");
  panel.clickAttr("data-probe", "burst");
  assert.deepEqual(resultOf(panel), { tone: "suppressed", text: "连发 ×3：只弹出 0/3 条，其余被前台抑制。" });
});

test("subscribe：订阅一次驱动重渲染，卸载即退订", () => {
  const service = createFakeService();
  const panel = renderPanel(service);

  assert.equal(service.calls.subscribe, 1);
  assert.equal(service.listenerCount(), 1);
  assert.equal(activeMode(panel), "auto");

  // 外部改覆盖（不是面板自己点的）也会让面板跟着更新——面板订阅了状态变化。
  service.setForegroundOverride("background");
  assert.equal(activeMode(panel), "background");
  assert.match(rowOf(panel, "page").text, /覆盖=强制失焦/);

  // 探针投递同样通知一次，最近投递行随之刷新。
  assert.equal(rowOf(panel, "deliver").text, "最近投递：（暂无）");
  panel.clickAttr("data-probe", "test");
  assert.match(rowOf(panel, "deliver").text, /browser · 已投递/);

  panel.unmount();
  assert.equal(service.calls.unsubscribe, 1);
  assert.equal(service.listenerCount(), 0);

  // 退订之后状态再变：面板不再重渲染（树内容不变），也不抛。
  const before = panel.text();
  service.setForegroundOverride("auto");
  service.setDiagnostics({ deliver: null });
  assert.equal(panel.text(), before);
});

test("快照 → 文案是纯函数：4 行固定、结果文案与色调可脱离 React 断言", () => {
  const t = createTranslator("zh");
  const rows = describeSnapshot({ foregroundOverride: "auto", diagnostics: {}, page: {} }, t);
  assert.deepEqual(rows.map((row) => row.key), ["status", "edge", "deliver", "page"]);
  assert.deepEqual(rows.slice(0, 3).map((row) => row.value), ["（暂无）", "（暂无）", "（暂无）"]);
  assert.equal(rows[3].value, "未知 · 聚焦=未知 · 失焦判定：前台 → 抑制投递 · 覆盖=跟随真实");

  assert.equal(describeResult(null, t), "");
  assert.equal(describeResult({ kind: "interrupted", delivered: false, total: 1 }, t),
    "未弹出：中断提醒 被前台抑制、没有投递（诊断里已留下 suppressed-foreground 记录）。");
  assert.equal(describeResult({ kind: "test", delivered: 1, total: 3 }, t), "连发 ×3：只弹出 1/3 条，其余被前台抑制。");
  assert.equal(describeResult({ kind: "test", delivered: 3, total: 3 }, t), "连发 ×3：3/3 条已弹出。");

  assert.equal(toneOf(null), "");
  assert.equal(toneOf({ delivered: 1, total: 1 }), "delivered");
  assert.equal(toneOf({ delivered: 0, total: 1 }), "suppressed");
  assert.equal(toneOf({ delivered: 0, total: 3 }), "suppressed");
  assert.equal(toneOf({ delivered: 1, total: 3 }), "partial");
  assert.equal(toneOf({ delivered: 3, total: 3 }), "delivered");

  assert.equal(
    describeDeliver({ channel: "webview", delivered: false, background: false, foregroundOverride: "auto" }, t),
    "webview · 未投出 · 页面=前台 · 投递时刻覆盖=跟随真实"
  );
});

test("样式表按标记安装/替换/卸载；文案跟随 DSH 界面语言（中英字典键集合一致）", () => {
  // 假 document：只够 installPanelStyle 用。
  const created = [];
  const head = {
    children: [],
    appendChild(node) { node.parentNode = head; head.children.push(node); }
  };
  const fakeDocument = {
    head,
    querySelector: () => null,
    createElement() {
      const node = {
        dataset: {},
        textContent: "",
        parentNode: null,
        remove() {
          node.parentNode = null;
          const index = head.children.indexOf(node);
          if (index >= 0) head.children.splice(index, 1);
        }
      };
      created.push(node);
      return node;
    }
  };

  const previous = globalThis.document;
  globalThis.document = fakeDocument;
  try {
    const dispose = installPanelStyle("@cningan/dsh-session-status-debug");
    assert.equal(head.children.length, 1);
    assert.equal(head.children[0].dataset.pluginCss, PANEL_STYLE_TAG);
    assert.equal(head.children[0].dataset.plugin, "@cningan/dsh-session-status-debug");
    assert.match(head.children[0].textContent, /\.dshss-dev-panel/);
    dispose();
    assert.equal(head.children.length, 0);
    // 重复卸载不抛。
    dispose();
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }

  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  for (const key of [
    "panelLabel", "panelTitle", "panelDescription", "modesLabel", "modeAuto", "modeForeground", "modeBackground",
    "modeStatus", "evidence", "yes", "no", "unknown", "none", "verdictBackground", "verdictForeground",
    "probesLabel", "probeTest", "probeInterrupted", "probeBurst", "probeNameTest", "probeNameInterrupted",
    "diagnosticsLabel", "labelSeparator", "diagStatus", "diagEdge", "diagDeliver", "diagPage", "empty", "statusValue",
    "subagentRuns", "currentSubagent",
    "edgePendingValue", "edgeSuppressedValue", "edgeTerminalValue", "deliverValue", "platformValue",
    "pageValue", "overrideValue", "verdictDelivered", "verdictSuppressed", "verdictNotDelivered",
    "pageBackground", "pageForeground", "resultDelivered", "resultSuppressed", "resultBurstAll", "resultBurstPartial"
  ]) {
    for (const lang of ["zh", "en"]) {
      assert.equal(typeof dictionaries[lang][key], "string", `${lang}.${key} 应有译文`);
    }
  }

  // 英文界面：面板整棵树都走英文，且不出现 key 原文。
  const english = renderPanel(createFakeService(), "en");
  assert.match(english.text(), /Development debug panel \(DEV/);
  assert.match(rowOf(english, "page").text, /Current page \/ foreground verdict:/);
  assert.equal(english.text().includes("panelTitle"), false);
  assert.equal(english.text().includes("diagStatus"), false);
});
