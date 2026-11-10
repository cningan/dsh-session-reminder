import assert from "node:assert/strict";
import test from "node:test";

import {
  INTERACTION_KINDS,
  TERMINAL_REASONS,
  classifyDetail,
  classifyInteraction,
  classifyTurnEnd,
  isSilent
} from "../lib/core/classify.mjs";

// 这些测试不模拟浏览器：core 是纯 module，接口即测试面。

test("completed is the only success reason", () => {
  assert.deepEqual(classifyTurnEnd({ kind: "completed" }), { reason: "completed", detail: "", silent: false });
});

test("maps every known failure kind to its own reason", () => {
  assert.equal(classifyTurnEnd({ kind: "blocked" }).reason, "blocked");
  assert.equal(classifyTurnEnd({ kind: "max-tokens" }).reason, "max-tokens");
  assert.equal(
    classifyTurnEnd({ kind: "error", error: { code: "MODEL_ERR", message: "quota exhausted" } }).reason,
    "error"
  );
  assert.equal(
    classifyTurnEnd({ kind: "error", error: { code: "MODEL_ERR", message: "quota exhausted" } }).detail,
    "MODEL_ERR: quota exhausted"
  );
});

test("keeps an unknown abort generic instead of guessing completion", () => {
  assert.equal(classifyTurnEnd({ kind: "aborted" }).reason, "interrupted");
  // 上游 `interrupted` 是**有含义**的原因（DSH 进程在回合结束前退出），不是「原因未知」：
  // 两者共用 `interrupted` 会把已知原因说成未知，用户看到的文案就不再说明发生了什么。
  assert.equal(classifyTurnEnd({ kind: "interrupted" }).reason, "process-interrupted");
  assert.equal(classifyTurnEnd({ kind: "forked" }).reason, "interrupted");
  assert.equal(classifyTurnEnd({ kind: "something-new" }).reason, "interrupted");
});

test("attributes aborts: user is silent, parent and hook have their own reason", () => {
  assert.equal(classifyTurnEnd({ kind: "aborted", reason: { kind: "user" } }).silent, true);
  assert.equal(isSilent(classifyTurnEnd({ kind: "aborted", reason: { kind: "user" } })), true);
  assert.equal(classifyTurnEnd({ kind: "aborted", reason: { kind: "parent" } }).reason, "aborted-parent");
  const hook = classifyTurnEnd({ kind: "aborted", reason: { kind: "hook", reason: "policy" } });
  assert.equal(hook.reason, "aborted-hook");
  assert.equal(hook.detail, "policy");
});

test("returns undefined for a turn/end that carries no usable shape", () => {
  assert.equal(classifyTurnEnd(undefined), undefined);
  assert.equal(classifyTurnEnd(null), undefined);
  assert.equal(classifyTurnEnd("completed"), undefined);
  assert.equal(classifyTurnEnd({ kind: 42 }), undefined);
});

test("detail fallback distinguishes agent error, prompt error and window error", () => {
  assert.equal(classifyDetail({ lastAgentError: "runtime blew up" }).reason, "agent-error");
  assert.equal(classifyDetail({ lastAgentError: "runtime blew up" }).detail, "runtime blew up");
  assert.equal(
    classifyDetail({ promptError: { error: { code: "EOP", message: "failed" } } }).reason,
    "prompt-error"
  );
  assert.equal(
    classifyDetail({ promptError: { error: { code: "EOP", message: "failed" } } }).detail,
    "EOP: failed"
  );
  assert.equal(classifyDetail({ openState: "error", openError: { code: "ENOENT" } }).reason, "session-open-error");
  assert.equal(classifyDetail({ openState: "error", openError: { code: "ENOENT" } }).detail, "ENOENT");
  assert.equal(classifyDetail({ openState: "error" }).detail, "");
  assert.equal(classifyDetail({}), undefined);
  assert.equal(classifyDetail(null), undefined);
});

test("truncates and collapses whitespace in details", () => {
  const detail = classifyTurnEnd({ kind: "error", error: { message: `  a\n\nb  ${"x".repeat(400)}` } });
  assert.equal(detail.detail.startsWith("a b "), true);
  assert.equal(detail.detail.length, 220);
});

test("interaction kinds fall back to question", () => {
  for (const kind of INTERACTION_KINDS) assert.equal(classifyInteraction(kind), kind);
  assert.equal(classifyInteraction("something-new"), "question");
  assert.equal(classifyInteraction(undefined), "question");
});

test("the reason vocabulary is frozen and covers every branch", () => {
  assert.equal(Object.isFrozen(TERMINAL_REASONS), true);
  for (const reason of ["completed", "interrupted", "blocked", "max-tokens", "error", "aborted-parent", "aborted-hook"]) {
    assert.ok(TERMINAL_REASONS.includes(reason), `vocabulary is missing ${reason}`);
  }
});
