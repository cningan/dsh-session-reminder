import assert from "node:assert/strict";
import test from "node:test";

import { dictionaries, pendingKind, terminalText } from "../lib/core/text.mjs";

// 用字典本身当 t：这里测的是「语义 → 文案」映射，不需要 DSH 的 locale 服务。
function makeT(lang) {
  const table = dictionaries[lang];
  return (key, params) => {
    const template = typeof table[key] === "string" ? table[key] : key;
    if (params === undefined) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
  };
}

test("maps every terminal reason to its own localized template", () => {
  const t = makeT("zh");
  assert.equal(terminalText({ reason: "completed", detail: "" }, t), "");
  assert.equal(terminalText({ reason: "interrupted", detail: "" }, t), "");
  assert.equal(terminalText({ reason: "blocked", detail: "" }, t), t("blocked"));
  assert.equal(terminalText({ reason: "max-tokens", detail: "" }, t), t("maxTokens"));
  assert.equal(terminalText({ reason: "aborted-parent", detail: "" }, t), t("abortedByParent"));
  assert.equal(terminalText({ reason: "aborted-hook", detail: "policy" }, t), t("abortedByHook", { reason: "policy" }));
  assert.equal(terminalText({ reason: "error", detail: "MODEL_ERR" }, t), t("turnError", { reason: "MODEL_ERR" }));
  assert.equal(terminalText({ reason: "agent-error", detail: "boom" }, t), t("agentError", { reason: "boom" }));
  assert.equal(
    terminalText({ reason: "prompt-error", detail: "EOP: failed" }, t),
    t("promptError", { reason: "EOP: failed" })
  );
  assert.equal(terminalText({ reason: "session-open-error", detail: "" }, t), t("openErrorGeneric"));
  assert.equal(
    terminalText({ reason: "session-open-error", detail: "ENOENT" }, t),
    t("openError", { reason: "ENOENT" })
  );
});

test("falls back to the generic stop text when a detail-carrying reason has none", () => {
  for (const lang of ["zh", "en"]) {
    const t = makeT(lang);
    const unknown = t("unknownStopped");
    assert.equal(terminalText({ reason: "error", detail: "" }, t), t("turnError", { reason: unknown }));
    assert.equal(terminalText({ reason: "aborted-hook", detail: "" }, t), t("abortedByHook", { reason: unknown }));
  }
});

test("english and chinese dictionaries carry the same keys", () => {
  assert.deepEqual(Object.keys(dictionaries.zh).sort(), Object.keys(dictionaries.en).sort());
  assert.ok(Object.keys(dictionaries.zh).length > 20);
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
  assert.match(dictionaries.zh.turnError, /\{reason\}/);
  assert.match(dictionaries.en.abortedByHook, /\{reason\}/);
});
