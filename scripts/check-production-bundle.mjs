#!/usr/bin/env node
/**
 * 断言**发布产物**（唯一的 `lib/client.js`）与它的默认姿态。
 *
 * 调试面板已经**并回主包**（挂在插件自己的详情页 `plugins.detail.section`），所以这条检查
 * 不再回答「产物里有没有调试 UI」——它回答的是三件事：
 *
 *   1. **历史残留不得回潮**：旧探针 API（`sendProbe` / `setTestMode`）、旧设置界面
 *      （`settings.section` 与 `dshss-settings*` 样式类名）都曾经被删除，不允许悄悄回来；
 *   2. **该在的都在**：测试服务 Hook（服务名 + 五个方法）与插件页挂载点；
 *   3. **默认关闭**：`devToolsEnabled` 的初值在源码里必须字面量是 `false`——面板随包分发，
 *      但正式使用里它不能有任何行为，这条断言就是那个保证的守门人。
 *
 * 只检查**代码特征**（标识符、slot 名、初始化语句），不检查文案字典。
 *
 * 退出码：0 = 符合预期；1 = 发现残留、缺件，或默认值被改成开启。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(join(root, "lib", "client.js"), "utf8");
const assembly = await readFile(join(root, "lib", "client", "assembly.mjs"), "utf8");

/** 不得出现在发布产物里的历史残留（曾经被删掉的能力）。 */
const FORBIDDEN = [
  ["旧探针 API", "sendProbe"],
  ["旧测试模式 API", "setTestMode"],
  ["旧诊断文本块", "诊断·"],
  ["旧探针文案键", "probeNotification"],
  // 设置界面已彻底移除：设置行的样式类名与 slot 注册都不得出现。
  ["设置行样式", "dshss-settings"],
  ["设置区 slot 注册", "settings.section"]
];

/** 必须出现在发布产物里的能力（阳性对照，避免断言永真）。 */
const REQUIRED = [
  ["测试服务名", "sessionStatusTest"],
  ["前台覆盖方法", "setForegroundOverride"],
  ["临时投递方法", "deliverAdHoc"],
  ["按原因模拟方法", "deliverSample"],
  ["调试工具总开关", "setDevToolsEnabled"],
  ["插件页挂载点", "plugins.detail.section"],
  ["调试面板样式", "dshss-dev-panel"]
];

/** 默认关闭：源码里的初值必须是字面量 false，且没有把它改成 true 的初始化。 */
const expectsOffByDefault = [
  { label: "devToolsEnabled 初值必须为 false", ok: assembly.includes("let devToolsEnabled = false;") },
  { label: "devToolsEnabled 不得以 true 初始化", ok: !/let devToolsEnabled = true;/.test(assembly) }
];

const found = FORBIDDEN.filter(([, marker]) => bundle.includes(marker));
const missing = REQUIRED.filter(([, marker]) => !bundle.includes(marker));
const wrong = expectsOffByDefault.filter((entry) => !entry.ok);
if (found.length > 0 || missing.length > 0 || wrong.length > 0) {
  if (found.length > 0) {
    console.error("FAIL: production bundle still contains removed debug/settings capabilities:");
    for (const [label, marker] of found) console.error(`  - ${label}: ${marker}`);
  }
  if (missing.length > 0) {
    console.error("FAIL: production bundle is missing an expected capability:");
    for (const [label, marker] of missing) console.error(`  - ${label}: ${marker}`);
  }
  if (wrong.length > 0) {
    console.error("FAIL: the debug tools must be off by default:");
    for (const entry of wrong) console.error(`  - ${entry.label}`);
  }
  console.error("\nRun `npm run build:client` before packing.");
  process.exit(1);
}
console.log(
  `OK: production bundle keeps ${REQUIRED.length} capabilities, none of the ${FORBIDDEN.length} removed ones, ` +
    `and the debug tools stay off by default (${bundle.length} bytes)`
);
