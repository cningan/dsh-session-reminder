import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { VERDICTS, analyze, parseRecords } from "../scripts/check-diagnostics.mjs";

// 读方（scripts/check-diagnostics.mjs）的可测面就是 analyze(records)：
// 固定样本 JSONL → 结论词 + 退出码，不碰真实 profile，也不模拟浏览器。

const SCRIPT = fileURLToPath(new URL("../scripts/check-diagnostics.mjs", import.meta.url));
const AT = "2026-09-26T00:00:00.000Z";
const KEY = "terminal:session-abc:1";

function line(event, payload) {
  return JSON.stringify({ at: AT, event, payload });
}

const EDGE = line("client:edge", { key: KEY, kind: "terminal", sessionId: "session-abc", suppressed: null });
const DELIVER = line("client:deliver", {
  key: KEY,
  kind: "interrupted",
  sessionId: "session-abc",
  channel: "browser",
  delivered: true,
  background: true,
  browserPermission: "granted",
  nativeBridge: false,
  userActivation: { active: false, everActive: true }
});
const platform = (event, error = null) => line("client:platform", { key: KEY, event, error });

/** ① 投递调用成功，平台确认显示。 */
const SAMPLE_SHOWN = [line("host-ready", { route: "/plugins/dsh-session-status/diagnostics" }), EDGE, DELIVER, platform("onshow")]
  .join("\n");
/** ② 投递调用成功，平台明确拒绝显示。 */
const SAMPLE_ERRORED = [line("host-ready", {}), EDGE, DELIVER, platform("onerror", "NotAllowedError: permission denied")]
  .join("\n");
/** ③ 投递调用成功，但平台一个字都没回——只有 deliver，没有任何平台事件。 */
const SAMPLE_CALLED_ONLY = [line("host-ready", {}), EDGE, DELIVER].join("\n");

function verdictOf(sample) {
  return analyze(parseRecords(sample));
}

test("an onshow platform event confirms the reminder was really shown", () => {
  const result = verdictOf(SAMPLE_SHOWN);
  assert.equal(result.label, "OK");
  assert.equal(result.code, VERDICTS.OK);
  assert.equal(result.code, 0);
  assert.match(result.message, /平台确认显示/);
  assert.match(result.message, /onshow/);
});

test("an onclose platform event is confirmation too (only a shown notice closes)", () => {
  const sample = [EDGE, DELIVER, platform("onclose")].join("\n");
  const result = verdictOf(sample);
  assert.equal(result.label, "OK");
  assert.equal(result.code, 0);
  assert.match(result.message, /onclose/);
});

test("an onerror platform event is an explicit failure that carries the error text", () => {
  const result = verdictOf(SAMPLE_ERRORED);
  assert.equal(result.label, "PLATFORM-ERROR");
  assert.equal(result.code, VERDICTS["PLATFORM-ERROR"]);
  assert.equal(result.code, 5);
  assert.match(result.message, /onerror/);
  assert.match(result.message, /NotAllowedError: permission denied/);
});

test("a successful delivery call with no platform event is never reported as success", () => {
  const result = verdictOf(SAMPLE_CALLED_ONLY);
  assert.notEqual(result.label, "OK");
  assert.equal(result.label, "UNCONFIRMED");
  assert.equal(result.code, VERDICTS.UNCONFIRMED);
  assert.equal(result.code, 4);
  assert.match(result.message, /投递调用成功但平台未确认/);
  // 结论文字不得把"调用成功"说成"已显示"。
  assert.doesNotMatch(result.message, /平台确认显示/);
});

test("a platform event for another key does not confirm this delivery (same-key requirement)", () => {
  const sample = [EDGE, DELIVER, line("client:platform", { key: "test:1", event: "onshow", error: null })].join("\n");
  const result = verdictOf(sample);
  assert.equal(result.label, "UNCONFIRMED");
  assert.equal(result.code, 4);
});

test("a platform rejection outranks a confirmed show of another key", () => {
  const sample = [EDGE, DELIVER, platform("onshow"), platform("onerror", "InvalidStateError: cannot show")].join("\n");
  const result = verdictOf(sample);
  assert.equal(result.label, "PLATFORM-ERROR");
  assert.equal(result.code, 5);
});

test("the reader still reports no stop edge as pending, not as a delivery verdict", () => {
  const result = verdictOf(line("host-ready", {}));
  assert.equal(result.label, "PENDING");
  assert.equal(result.code, 3);
});

test("the CLI exits with the verdict code from the single-source table", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dsh-session-status-check-"));
  try {
    for (const [sample, expected] of [
      [SAMPLE_SHOWN, { label: "OK", code: 0 }],
      [SAMPLE_ERRORED, { label: "PLATFORM-ERROR", code: 5 }],
      [SAMPLE_CALLED_ONLY, { label: "UNCONFIRMED", code: 4 }]
    ]) {
      const file = join(dir, `${expected.label}.jsonl`);
      await writeFile(file, `${sample}\n`, "utf8");
      const run = spawnSync(process.execPath, [SCRIPT, file], { encoding: "utf8" });
      assert.equal(run.status, expected.code, `exit code for ${expected.label}: ${run.stdout}${run.stderr}`);
      assert.equal(run.status, VERDICTS[expected.label]);
      assert.match(run.stdout, new RegExp(`VERDICT: ${expected.label}`));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI reports NO-DATA (2) when the file is missing", () => {
  const run = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), "dsh-session-status-does-not-exist.jsonl")], {
    encoding: "utf8"
  });
  assert.equal(run.status, VERDICTS["NO-DATA"]);
  assert.match(run.stdout, /VERDICT: NO-DATA/);
});
