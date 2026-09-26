#!/usr/bin/env node
/**
 * 会话提醒的诊断回路（feedback loop）。
 *
 * 读取 Host 半边落盘的 diagnostics.jsonl，判定"停止边沿是否被观察到、当时是否
 * 失焦、投递调用是否成功、平台是否真的显示过"，并给出结论 + 可机读退出码。
 *
 * 退出码与结论词的**唯一定义**在下方 VERDICTS 表（SPEC.md 与 README 只引用本文件，
 * 不再各写一份，避免三处漂移）：
 *
 *   0  OK              投递调用成功，且平台确认显示过（同一 key 的 onshow 或 onclose）
 *   1  FAIL            链路断开（源契约不符 / 边沿被抑制 / 前台静默 / 投递调用失败）
 *   2  NO-DATA         读不到诊断文件（Host 未加载或未写入）
 *   3  PENDING         有诊断，但还没观察到停止边沿
 *   4  UNCONFIRMED     投递调用成功，但平台对该 key 零反馈——未确认显示
 *   5  PLATFORM-ERROR  平台明确拒绝显示（onerror，附 error 文本）
 *
 * 「投递调用成功」（`delivered: true`，即 `new Notification()` 没抛错）与「平台确认
 * 显示」是两件事：只有同一 key 的 `onshow` / `onclose` 才证明平台真的显示过。
 * 这正是 ADR-0001（不使用 requireInteraction、tag 唯一且短）的证据链
 * ——见 docs/adr/0001-no-require-interaction-short-unique-tags.md。
 *
 * 用法：node scripts/check-diagnostics.mjs [diagnostics.jsonl 路径]
 */
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 结论词 → 退出码。诊断结论与退出码的单一来源。 */
export const VERDICTS = Object.freeze({
  OK: 0,
  FAIL: 1,
  "NO-DATA": 2,
  PENDING: 3,
  UNCONFIRMED: 4,
  "PLATFORM-ERROR": 5
});

/** 平台事件名（Chromium Notification 生命周期），只有前两者算"确认显示"。 */
const PLATFORM_SHOWN_EVENTS = Object.freeze(["onshow", "onclose"]);

function conclusion(label, message, report = []) {
  return { label, code: VERDICTS[label], message, report };
}

/** 把 JSONL 文本解析为记录数组；半行/坏行（写入竞争）忽略。 */
export function parseRecords(text) {
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // 半行/坏行（写入竞争）忽略
    }
  }
  return records;
}

/**
 * 纯判定：吃诊断记录，吐出结论（label / code / message）与给人看的明细行。
 * 不做 IO、不退出进程，因此测试可以直接喂固定样本。
 */
export function analyze(records) {
  const report = [];
  const edges = records.filter((r) => r.event === "client:edge");
  const deliveries = records.filter((r) => r.event === "client:deliver");
  const platforms = records.filter((r) => r.event === "client:platform");

  // ① 源契约：数据源形状不符时插件会直接放弃，不再有任何边沿。
  const shapes = records.filter((r) => r.event === "client:source-shape");
  if (shapes.length > 0) {
    for (const shape of shapes) report.push(`SHAPE-BROKEN: ${JSON.stringify(shape.payload)}`);
    return conclusion(
      "FAIL",
      "官方数据源形状与插件假设不符（见上方 SHAPE-BROKEN）——这会让所有边沿判定直接中止。",
      report
    );
  }

  // ② 状态源摘要：确认 running / 当前会话是否出现在官方快照里。
  const lastStatus = records.filter((r) => r.event === "client:status").at(-1)?.payload;
  if (lastStatus !== undefined) {
    report.push("");
    report.push(`STATUS: entries=${lastStatus.statusEntries} currentId=${lastStatus.currentId}`
      + ` currentInStatuses=${lastStatus.currentInStatuses} listHandlesCurrent=${lastStatus.listHandlesCurrent}`);
    report.push(`  runs: ${JSON.stringify(lastStatus.runs)}`);
  }

  report.push("");
  for (const edge of edges) report.push(`EDGE:     ${JSON.stringify(edge.payload)}`);
  for (const delivery of deliveries) report.push(`DELIVER:  ${JSON.stringify(delivery.payload)}`);
  for (const platform of platforms) report.push(`PLATFORM: ${JSON.stringify(platform.payload)}`);

  // ③ 平台明确拒绝：onerror 是失败结论，优先于任何"成功"结论。
  const platformErrors = platforms.filter((p) => p.payload?.event === "onerror");
  if (platformErrors.length > 0) {
    const details = platformErrors
      .map((p) => `${p.payload?.key ?? "?"} → ${p.payload?.error ?? "unknown"}`)
      .join("；");
    report.push("");
    return conclusion(
      "PLATFORM-ERROR",
      `平台拒绝显示通知（onerror）：${details}——投递调用没抛错，但平台没有呈现。`,
      report
    );
  }

  const delivered = deliveries.filter((d) => d.payload?.delivered === true);
  const shownEvents = (key) => platforms
    .filter((p) => p.payload?.key === key && PLATFORM_SHOWN_EVENTS.includes(p.payload?.event))
    .map((p) => p.payload.event);
  const platformEventNames = (key) => platforms
    .filter((p) => p.payload?.key === key)
    .map((p) => p.payload?.event)
    .filter((event) => event !== undefined);

  // ④ 投递调用成功 + 同一 key 有 onshow/onclose → 平台确认显示的强结论。
  const confirmed = delivered.find((d) => d.payload?.key !== undefined && shownEvents(d.payload.key).length > 0);
  if (confirmed !== undefined) {
    const key = confirmed.payload.key;
    report.push("");
    return conclusion(
      "OK",
      `平台确认显示（${key} → ${shownEvents(key).join("/")}）：${JSON.stringify(confirmed.payload)}`,
      report
    );
  }

  // ⑤ 投递调用成功，但平台零反馈：不得给出"成功"结论。
  const unconfirmed = delivered.find((d) => platformEventNames(d.payload?.key).length === 0);
  if (unconfirmed !== undefined) {
    const key = unconfirmed.payload?.key;
    report.push("");
    return conclusion(
      "UNCONFIRMED",
      `投递调用成功但平台未确认：${JSON.stringify(unconfirmed.payload)}`
      + `——new Notification() 不抛错只说明调用没失败，key ${key ?? "?"} 没有任何`
      + " onshow/onerror/onclose，平台是否真的显示过仍未知（ADR-0001 所需的证据缺失）。",
      report
    );
  }

  // ⑥ 失败归因。
  const suppressedForeground = deliveries.find((d) => d.payload?.channel === "suppressed-foreground");
  if (suppressedForeground !== undefined) {
    return conclusion(
      "FAIL",
      `边沿被观察到但页面未失焦（background=${suppressedForeground.payload.background}）：`
      + "插件按设计在前台静默，这不是投递故障，需要真实隐藏/失焦窗口再测。",
      report
    );
  }
  const failedDelivery = deliveries.find((d) => d.payload?.delivered === false);
  if (failedDelivery !== undefined) {
    return conclusion("FAIL", `投递失败：${JSON.stringify(failedDelivery.payload)}`, report);
  }
  const suppressedEdge = edges.find((e) => e.payload?.suppressed !== null && e.payload?.suppressed !== undefined);
  if (suppressedEdge !== undefined) {
    return conclusion("FAIL", `停止边沿被抑制：${JSON.stringify(suppressedEdge.payload)}`, report);
  }
  const terminalEdge = edges.find((e) => e.payload?.kind === "terminal");
  if (terminalEdge === undefined) {
    return conclusion("PENDING", "还没有观察到任何停止边沿（running: true → false）。让一个普通会话真实跑完再来读。", report);
  }
  return conclusion(
    "FAIL",
    `观察到了停止边沿但没有投递记录：${JSON.stringify(terminalEdge.payload)}`
    + "——检查 classifyTurnEnd/removed 等提前返回分支。",
    report
  );
}

function defaultFile() {
  return join(
    process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? ".",
    ".dsh-session-status",
    "diagnostics.jsonl"
  );
}

function print(result) {
  for (const line of result.report) console.log(line);
  console.log("");
  console.log(`VERDICT: ${result.label}`);
  console.log(result.message);
}

async function main() {
  const file = process.argv[2] ?? defaultFile();
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    print(conclusion("NO-DATA", `cannot read ${file}: ${error.message}`));
    process.exitCode = VERDICTS["NO-DATA"];
    return;
  }

  const records = parseRecords(text);
  console.log(`FILE:    ${file}`);
  console.log(`RECORDS: ${records.length}`);
  const byEvent = new Map();
  for (const record of records) {
    const key = record.event ?? "?";
    byEvent.set(key, (byEvent.get(key) ?? 0) + 1);
  }
  for (const [event, count] of [...byEvent].sort()) console.log(`  ${event.padEnd(24)} ${count}`);

  const result = analyze(records);
  print(result);
  process.exitCode = result.code;
}

/** 只有被直接执行时才跑 CLI；被 import（测试）时只暴露 VERDICTS/parseRecords/analyze。 */
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return resolve(entry).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
  } catch {
    return false;
  }
}

if (invokedDirectly()) await main();
