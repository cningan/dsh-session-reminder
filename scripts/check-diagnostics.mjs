#!/usr/bin/env node
/**
 * 会话提醒的诊断回路（feedback loop）。
 *
 * 读取 Host 半边落盘的 diagnostics.jsonl，判定"停止边沿是否被观察到、当时是否
 * 失焦、投递结果如何"，并给出结论 + 可机读退出码：
 *
 *   0  OK       停止提醒已在失焦状态下投递成功
 *   1  FAIL     有诊断，但链路断了（源契约不符 / 边沿被抑制 / 前台静默 / 投递失败）
 *   2  NO-DATA  读不到诊断文件（Host 未加载或未写入）
 *   3  PENDING  有诊断，但还没观察到停止边沿
 *
 * 用法：node scripts/check-diagnostics.mjs [diagnostics.jsonl 路径]
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const file = process.argv[2]
  ?? join(process.env.DSH_PROFILE_DIR ?? process.env.DSH_HOME ?? ".", ".dsh-session-status", "diagnostics.jsonl");

function verdict(label, message, code) {
  console.log("");
  console.log(`VERDICT: ${label}`);
  console.log(message);
  process.exit(code);
}

let text;
try {
  text = await readFile(file, "utf8");
} catch (error) {
  verdict("NO-DATA", `cannot read ${file}: ${error.message}`, 2);
}

const records = [];
for (const line of text.split("\n")) {
  if (line.trim() === "") continue;
  try {
    records.push(JSON.parse(line));
  } catch {
    // 半行/坏行（写入竞争）忽略
  }
}

const byEvent = new Map();
for (const record of records) {
  const key = record.event ?? "?";
  byEvent.set(key, (byEvent.get(key) ?? 0) + 1);
}

console.log(`FILE:    ${file}`);
console.log(`RECORDS: ${records.length}`);
for (const [event, count] of [...byEvent].sort()) console.log(`  ${event.padEnd(24)} ${count}`);

// ① 源契约：数据源形状不符时插件会直接放弃，不再有任何边沿。
const shapes = records.filter((r) => r.event === "client:source-shape");
if (shapes.length > 0) {
  for (const shape of shapes) console.log(`SHAPE-BROKEN: ${JSON.stringify(shape.payload)}`);
  verdict("FAIL", "官方数据源形状与插件假设不符（见上方 SHAPE-BROKEN）——这会让所有边沿判定直接中止。", 1);
}

// ② 状态源摘要：确认 running / 当前会话是否出现在官方快照里。
const statuses = records.filter((r) => r.event === "client:status");
const lastStatus = statuses.at(-1)?.payload;
if (lastStatus !== undefined) {
  console.log("");
  console.log(`STATUS: entries=${lastStatus.statusEntries} currentId=${lastStatus.currentId}`
    + ` currentInStatuses=${lastStatus.currentInStatuses} listHandlesCurrent=${lastStatus.listHandlesCurrent}`);
  console.log(`  runs: ${JSON.stringify(lastStatus.runs)}`);
}

const edges = records.filter((r) => r.event === "client:edge");
const deliveries = records.filter((r) => r.event === "client:deliver");
console.log("");
for (const edge of edges) console.log(`EDGE:    ${JSON.stringify(edge.payload)}`);
for (const delivery of deliveries) console.log(`DELIVER: ${JSON.stringify(delivery.payload)}`);

// ③ 投递结果优先：成功即绿。
const delivered = deliveries.find((d) => d.payload?.delivered === true);
if (delivered !== undefined) {
  verdict("OK", `reminder delivered: ${JSON.stringify(delivered.payload)}`, 0);
}

// ④ 失败归因。
const suppressedForeground = deliveries.find((d) => d.payload?.channel === "suppressed-foreground");
if (suppressedForeground !== undefined) {
  verdict("FAIL", `边沿被观察到但页面未失焦（background=${suppressedForeground.payload.background}）：`
    + "插件按设计在前台静默，这不是投递故障，需要真实隐藏/失焦窗口再测。", 1);
}
const failedDelivery = deliveries.find((d) => d.payload?.delivered === false);
if (failedDelivery !== undefined) {
  verdict("FAIL", `投递失败：${JSON.stringify(failedDelivery.payload)}`, 1);
}
const suppressedEdge = edges.find((e) => e.payload?.suppressed !== null && e.payload?.suppressed !== undefined);
if (suppressedEdge !== undefined) {
  verdict("FAIL", `停止边沿被抑制：${JSON.stringify(suppressedEdge.payload)}`, 1);
}
const terminalEdge = edges.find((e) => e.payload?.kind === "terminal");
if (terminalEdge === undefined) {
  verdict("PENDING", "还没有观察到任何停止边沿（running: true → false）。让一个普通会话真实跑完再来读。", 3);
}
verdict("FAIL", `观察到了停止边沿但没有投递记录：${JSON.stringify(terminalEdge.payload)}`
  + "——检查 classifyTurnEnd/removed 等提前返回分支。", 1);
