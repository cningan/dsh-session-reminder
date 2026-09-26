/**
 * 归一化层直测（`lib/client/normalize.mjs`）：**不模拟浏览器、不 import vm**——只喂纯
 * 输入（官方快照片段：会话行、全会话状态映射、选中会话详情、宿主页面替身），断言领域
 * 快照。装配层的 `vm` 集成测试只保留端到端链路，这里承担「官方字段名 → 领域形状」的
 * 每一条分支：
 *
 *   1. 标题三段回退（displayTitle → title → sessionId）；
 *   2. 详情抽取（lastAgentError / promptError / openError 的 code 与 message 组合）；
 *   3. 列表行与状态映射的归一化（inList、pending 的**对象同一性**与 kind、removed）；
 *   4. 前台判定的四种情形（隐藏 / 失焦 / 可见且聚焦 / 没有宿主页面）——它是整条插件最
 *      承重的前置条件「仅在前台之外投递」；
 *   5. 单一来源防线：`lib/` 下只有归一化 module 读页面可见性/焦点（其余 module 只能
 *      消费它的产出），防止诊断展示与投递判定再次各写一份等价表达式。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  detailShapeOf,
  normalizeCurrent,
  normalizeSessions,
  readPageState,
  titleOf
} from "../lib/client/normalize.mjs";

const LIB_ROOT = fileURLToPath(new URL("../lib", import.meta.url));

// ── ① 标题三段回退 ────────────────────────────────────────────────────────────

test("标题回退链：displayTitle → title → sessionId，空串与非字符串都继续回退", () => {
  // 第一段：官方显示名优先。
  assert.equal(titleOf({ displayTitle: "Display", title: "Plain" }, "s1"), "Display");
  // 第二段：没有显示名时用 title。
  assert.equal(titleOf({ title: "Plain" }, "s1"), "Plain");
  // 第三段：列表行缺失（undefined）、空行或字段为空串时退回会话 id。
  assert.equal(titleOf(undefined, "s1"), "s1");
  assert.equal(titleOf({}, "s1"), "s1");
  assert.equal(titleOf({ displayTitle: "", title: "" }, "s1"), "s1");
  assert.equal(titleOf({ displayTitle: 42, title: null }, "s1"), "s1");
});

// ── ② 详情抽取（lastAgentError / promptError / openError）────────────────────

test("详情抽取：lastAgentError 与 openState 原样带走，没有的字段给 null", () => {
  assert.deepEqual(detailShapeOf({ lastAgentError: "boom", openState: "error" }), {
    lastAgentError: "boom",
    promptError: null,
    openState: "error",
    openError: null
  });
  // 空快照：每个字段都有自己的缺省值，不让 undefined 漏进领域形状。
  assert.deepEqual(detailShapeOf({}), {
    lastAgentError: null,
    promptError: null,
    openState: null,
    openError: null
  });
  // 形状不符（null / 非对象 / undefined）时没有详情可言。
  for (const input of [null, undefined, "boom", 7]) {
    assert.equal(detailShapeOf(input), undefined, `${String(input)} 不应产出详情形状`);
  }
});

test("详情抽取：promptError 取 code + message，只有 message 时 code 为 null", () => {
  const withBoth = detailShapeOf({ promptError: { error: { code: "E_NET", message: "offline" } } });
  assert.deepEqual(withBoth.promptError, { error: { code: "E_NET", message: "offline" } });
  assert.equal(withBoth.lastAgentError, null);

  const messageOnly = detailShapeOf({ promptError: { error: { message: "offline" } } });
  assert.deepEqual(messageOnly.promptError, { error: { code: null, message: "offline" } });

  // promptError 在场但没有 error 对象：保住「有 promptError 这一层」的形状，error 为 null。
  const noError = detailShapeOf({ promptError: {} });
  assert.deepEqual(noError.promptError, { error: null });

  // promptError 不是对象时等于没有。
  assert.equal(detailShapeOf({ promptError: "offline" }).promptError, null);
});

test("详情抽取：openError 取 code + message，只有 code 时 message 为 null", () => {
  const both = detailShapeOf({ openState: "error", openError: { code: "ENOENT", message: "missing" } });
  assert.deepEqual(both.openError, { code: "ENOENT", message: "missing" });

  const codeOnly = detailShapeOf({ openState: "error", openError: { code: "ENOENT" } });
  assert.deepEqual(codeOnly.openError, { code: "ENOENT", message: null });

  // openError 不是对象（undefined / null / 字符串）时没有错误对。
  for (const openError of [undefined, null, "ENOENT"]) {
    assert.equal(detailShapeOf({ openError }).openError, null, `openError=${String(openError)} 应为 null`);
  }
});

// ── ③ 列表行 + 状态映射 → 领域会话快照 ───────────────────────────────────────

test("会话归一化：标题、运行/未读布尔位与 inList（列表里没有这一行）", () => {
  const rows = { a: { title: "Alpha" }, b: { displayTitle: "Beta" } };
  const statuses = new Map([
    ["a", { running: true, completionUnread: false }],
    // 状态里有、列表行里没有：inList 为假（可能是归档/移除），标题退回会话 id。
    ["b", { running: false, completionUnread: true }],
    ["c", {}]
  ]);

  assert.deepEqual(normalizeSessions(rows, statuses), [
    { id: "a", title: "Alpha", running: true, pending: null, unread: false, inList: true },
    { id: "b", title: "Beta", running: false, pending: null, unread: true, inList: true },
    { id: "c", title: "c", running: false, pending: null, unread: false, inList: false }
  ]);

  // 列表行整个缺失（形状不符）：全部 inList 为假，标题退回会话 id。
  const withoutList = normalizeSessions(undefined, new Map([["a", { running: true }]]));
  assert.deepEqual(withoutList, [
    { id: "a", title: "a", running: true, pending: null, unread: false, inList: false }
  ]);

  // 状态源不可迭代：没有会话可判定（调用方本来就会先校验形状并上报 source-shape）。
  assert.deepEqual(normalizeSessions(rows, undefined), []);
});

test("会话归一化：pending 原样带走同一个交互对象与它的 kind（等待边沿按对象同一性判断）", () => {
  const approval = { kind: "approval", requestId: "r1" };
  const question = { kind: "question" };
  const sessions = normalizeSessions({}, new Map([
    ["a", { running: true, pendingInteraction: approval }],
    ["b", { running: true, pendingInteraction: question }],
    ["c", { running: true, pendingInteraction: undefined }]
  ]));

  // 同一个对象：不是复制、不是重造——判定核心据此区分「换了等待」与「还是那个等待」。
  assert.equal(sessions[0].pending, approval);
  assert.equal(sessions[1].pending, question);
  assert.equal(sessions[0].pending.kind, "approval");
  assert.equal(sessions[1].pending.kind, "question");
  // 没有等待时是 null（不是 undefined），与领域契约一致。
  assert.equal(sessions[2].pending, null);
});

test("选中会话归一化：removed 标记、turn/end 原始原因与详情形状", () => {
  const turnEnd = { kind: "error", error: { code: "E1", message: "boom" } };
  const shaped = normalizeCurrent({ removed: true, lastAgentError: "boom" }, turnEnd);

  assert.equal(shaped.removed, true);
  // 原始原因对象原样交给判定核心（嵌套归属不被装配层改写）。
  assert.equal(shaped.turnEnd, turnEnd);
  assert.deepEqual(shaped.detail, {
    lastAgentError: "boom",
    promptError: null,
    openState: null,
    openError: null
  });

  // 详情还没到（undefined）：removed 为假、详情为 undefined，本轮不该凭它报出原因。
  const empty = normalizeCurrent(undefined, undefined);
  assert.equal(empty.removed, false);
  assert.equal(empty.turnEnd, undefined);
  assert.equal(empty.detail, undefined);

  // removed 只在严格 true 时算「已显式移除」。
  assert.equal(normalizeCurrent({ removed: "yes" }, undefined).removed, false);
});

// ── ④ 前台判定（唯一来源）────────────────────────────────────────────────────

test("前台判定：隐藏 / 失焦 / 可见且聚焦 / 没有宿主页面四种情形", () => {
  // ① 页面隐藏：无论焦点如何都算前台之外。
  assert.deepEqual(readPageState({ visibilityState: "hidden", hasFocus: () => true }), {
    visibility: "hidden",
    focused: true,
    background: true
  });

  // ② 可见但失焦。
  assert.deepEqual(readPageState({ visibilityState: "visible", hasFocus: () => false }), {
    visibility: "visible",
    focused: false,
    background: true
  });

  // ③ 可见且聚焦：唯一不投递的组合。
  assert.deepEqual(readPageState({ visibilityState: "visible", hasFocus: () => true }), {
    visibility: "visible",
    focused: true,
    background: false
  });

  // ④ 没有宿主页面（显式 null；缺参时读全局，而 Node 直测里没有全局 document）。
  const noDocument = { visibility: null, focused: null, background: false };
  assert.deepEqual(readPageState(null), noDocument);
  assert.deepEqual(readPageState(undefined), noDocument);
  assert.equal(typeof globalThis.document, "undefined", "本直测假定 Node 里没有全局 document");
  assert.deepEqual(readPageState(), noDocument);

  // 焦点函数缺失或抛错：只丢 focused 这一位，不影响隐藏这一位的结论。
  assert.deepEqual(readPageState({ visibilityState: "visible" }), {
    visibility: "visible",
    focused: null,
    background: false
  });
  assert.deepEqual(readPageState({
    visibilityState: "visible",
    hasFocus: () => { throw new Error("no focus info"); }
  }), { visibility: "visible", focused: null, background: false });
});

// ── ⑤ 单一来源防线 ───────────────────────────────────────────────────────────

/** `lib/` 下所有 `.mjs` 源文件（不含构建产物 `lib/client.js`，它是打包结果）。 */
async function moduleFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await moduleFiles(full));
    else if (entry.name.endsWith(".mjs")) found.push(full);
  }
  return found;
}

test("前台判定在 lib/ 下只有一处实现：可见性/焦点只由归一化 module 读取", async () => {
  const files = await moduleFiles(LIB_ROOT);
  const names = files.map((file) => relative(LIB_ROOT, file).split(sep).join("/"));

  // 阳性对照：扫描面确实覆盖了归一化 module 与它的消费方，避免断言退化成永真。
  for (const expected of ["client/normalize.mjs", "client/assembly.mjs", "client/test-service.mjs", "client/settings.mjs"]) {
    assert.ok(names.includes(expected), `扫描面应包含 ${expected}`);
  }

  const readers = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (/visibilityState|hasFocus/.test(text)) readers.push(relative(LIB_ROOT, file).split(sep).join("/"));
  }

  // 设置区（诊断展示）与装配层（投递判定）都只能消费归一化的产出：任一处再写一次
  // 等价表达式，这条断言就会失败。
  assert.deepEqual(readers, ["client/normalize.mjs"], "页面可见性/焦点只允许在 client/normalize 里读取");
});
