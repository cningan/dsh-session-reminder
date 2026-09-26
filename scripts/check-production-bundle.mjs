#!/usr/bin/env node
/**
 * 断言**发布产物**（唯一的 `lib/client.js`）的表面：不含调试 UI、不含任何设置界面，
 * 且带着测试服务 Hook。
 *
 * 测试能力已移出主插件（诊断面板、探针、测试模式开关都在仓库内 `dev/` 的独立调试插件里，
 * 见 [ADR-0003](../docs/adr/0003-test-capability-lives-outside-the-plugin.md)）。因此这条
 * 检查不再回答「这是调试构建还是正式构建」（只有一种构建），而是回答两件事：
 *
 *   1. **负向**：发布产物里没有任何调试 UI / 旧调试 API 的痕迹，也**没有任何设置界面**
 *      （设置行样式类名、`settings.section` 的注册）——它们都不得回潮到主插件；
 *   2. **正向**：产物里有测试服务 Hook（服务名与它的方法）——阳性对照，避免这条断言在
 *      「什么都没检查」的情况下永真。
 *
 * 只检查**代码特征**（诊断文本模板、旧调试 API 的标识符、CSS 类名、slot 名）：字典键属于
 * 数据，且调试文案与设置区文案都已随各自能力移出（`lib/core/text.mjs` 里不再有 `probe*` /
 * `testMode*` / `notifications*` / `enableNotifications` 这类键）。
 *
 * 退出码：0 = 产物表面符合预期；1 = 发现调试/设置残留或 Hook 缺失。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(join(root, "lib", "client.js"), "utf8");

/** 不得出现在发布产物里的调试 / 设置界面痕迹。 */
const FORBIDDEN = [
  ["诊断文本块", "诊断·"],
  ["旧探针 API", "sendProbe"],
  ["旧测试模式 API", "setTestMode"],
  ["调试 UI 样式（诊断块）", "dshss-settings-diagnostics"],
  ["调试 UI 样式（工具行）", "dshss-settings-tools"],
  ["调试面板文案", "probeNotification"],
  // 主插件不含任何设置 UI：设置行的样式类名与 slot 注册都不得出现。
  ["设置行样式", "dshss-settings"],
  ["设置区 slot 注册", "settings.section"]
];

/** 必须出现在发布产物里的测试服务 Hook（阳性对照）。 */
const REQUIRED = [
  ["测试服务名", "sessionStatusTest"],
  ["前台覆盖方法", "setForegroundOverride"],
  ["临时投递方法", "deliverAdHoc"]
];

const found = FORBIDDEN.filter(([, marker]) => bundle.includes(marker));
const missing = REQUIRED.filter(([, marker]) => !bundle.includes(marker));
if (found.length > 0 || missing.length > 0) {
  if (found.length > 0) {
    console.error("FAIL: production bundle still contains debug or settings UI:");
    for (const [label, marker] of found) console.error(`  - ${label}: ${marker}`);
  }
  if (missing.length > 0) {
    console.error("FAIL: production bundle is missing the test-service hook:");
    for (const [label, marker] of missing) console.error(`  - ${label}: ${marker}`);
  }
  console.error("\nRun `npm run build:client` before packing.");
  process.exit(1);
}
console.log(`OK: production bundle has no debug/settings UI and exposes ${REQUIRED.length} hook markers (${bundle.length} bytes)`);
