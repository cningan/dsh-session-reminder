import assert from "node:assert/strict";
import test from "node:test";

import { dictionaries, pendingKind, terminalBody, terminalHeadline } from "../lib/core/text.mjs";

// 用字典本身当 t：这里测的是「语义 → 文案」映射，不需要 DSH 的 locale 服务。
function makeT(lang) {
  const table = dictionaries[lang];
  return (key, params) => {
    const template = typeof table[key] === "string" ? table[key] : key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

test("每个终止原因都有自己的标题，且彼此不同——这是「提示不再都一样」的那一半", () => {
  const t = makeT("zh");
  const reasons = [
    "completed", "interrupted", "process-interrupted", "blocked", "max-tokens",
    "error", "agent-error", "prompt-error", "session-open-error", "aborted-parent", "aborted-hook"
  ];
  const headlines = reasons.map((reason) => terminalHeadline(reason, t));

  for (const [index, headline] of headlines.entries()) {
    assert.equal(typeof headline, "string");
    assert.notEqual(headline, "", `${reasons[index]} 应有标题`);
  }
  // 除「未知原因」的兜底外，每个原因都必须给出**不同**的一句：共用一个标题就等于没修。
  const distinct = new Set(headlines);
  assert.equal(distinct.size, reasons.length, "每个原因的标题都应不同");
  // 未知 reason 回落到通用兜底，而不是编一个原因。
  assert.equal(terminalHeadline("something-new", t), t("interrupted"));
});

test("正文只补充标题没说的细节：错误码/消息与扩展原因，其余不重复", () => {
  const t = makeT("zh");
  assert.equal(terminalBody({ reason: "error", detail: "MODEL_ERR: quota exhausted" }, t), "MODEL_ERR: quota exhausted");
  assert.equal(terminalBody({ reason: "agent-error", detail: "boom" }, t), "boom");
  assert.equal(terminalBody({ reason: "prompt-error", detail: "EOP: failed" }, t), "EOP: failed");
  assert.equal(terminalBody({ reason: "aborted-hook", detail: "policy" }, t), "policy");
  assert.equal(terminalBody({ reason: "session-open-error", detail: "ENOENT" }, t), "ENOENT");

  // 标题已经说清的：正文留空，调用方因此不再拼分隔符（不会出现「本轮被阻止：本轮被阻止」）。
  for (const reason of ["completed", "blocked", "max-tokens", "aborted-parent", "process-interrupted"]) {
    assert.equal(terminalBody({ reason, detail: "" }, t), "", `${reason} 的正文应为空`);
  }

  // 通用停止：唯一能说的就是「原因不可知」。
  assert.equal(terminalBody({ reason: "interrupted", detail: "" }, t), t("unknownStopped"));
});

test("带 detail 的原因若 detail 为空，退回「原因不可知」而不是编一个细节", () => {
  for (const lang of ["zh", "en"]) {
    const t = makeT(lang);
    const unknown = t("unknownStopped");
    for (const reason of ["error", "agent-error", "prompt-error", "aborted-hook", "session-open-error"]) {
      assert.equal(terminalBody({ reason, detail: "" }, t), unknown, `${reason}（${lang}）应退回通用说明`);
      assert.equal(terminalBody({ reason, detail: "   " }, t), unknown, `${reason}（${lang}）空白 detail 也算空`);
    }
  }
});

test("english and chinese dictionaries carry the same keys", () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  // 字典只剩**通知文案**（含测试服务投递的那条固定载荷）：门限随设置界面移除下调，
  // 它只防「字典被清空」，不是行为断言；设置区专有键由下一条断言显式锁死。
  assert.ok(Object.keys(dictionaries.zh).length > 15);
});

test("设置区专有文案键已随设置界面移除", () => {
  for (const lang of ["zh", "en"]) {
    for (const gone of [
      "notifications",
      "notificationsDescription",
      "enableNotifications",
      "enabledNotifications",
      "nativeBridgeDetected",
      "testNotification",
      "testNotificationSent",
      "testNotificationFailed",
      "notificationDenied",
      "notificationUnavailable"
    ]) {
      assert.equal(gone in dictionaries[lang], false, `设置区文案 ${gone} 应随设置界面移除（${lang}）`);
    }
  }
  // 阳性对照：测试服务投递的那条固定载荷仍要用到这两个键。
  assert.equal(typeof dictionaries.zh.testNotificationTitle, "string");
  assert.equal(typeof dictionaries.zh.testNotificationMessage, "string");
});

test("pending kinds map to their own words and fall back to question", () => {
  const t = makeT("en");
  assert.equal(pendingKind(t, "approval"), t("approval"));
  assert.equal(pendingKind(t, "plan-review"), t("planReview"));
  assert.equal(pendingKind(t, "something-new"), t("question"));
  assert.equal(pendingKind(t, undefined), t("question"));
});

test("the localized templates still carry their placeholders", () => {
  assert.match(dictionaries.zh.waitTitle, /\{kind\}/);
  assert.match(dictionaries.en.waitTitle, /\{kind\}/);
});
