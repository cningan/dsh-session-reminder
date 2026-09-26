#!/usr/bin/env node
/**
 * 断言**正式产物不含调试能力**。
 *
 * 调试机制（诊断文本块、探针、测试模式开关）只应存在于调试构建：
 * 仓库保留它们以便本地排查（`npm run build:client:debug`，`npm test` 会先用它构建），
 * 但发布包（`npm pack` → `prepack` → 生产构建）不得带上这些页面与 API。
 *
 * 只检查**代码特征**（诊断文本模板、探针/测试模式的实现标识）：CSS 类名与字典键
 * 属于数据，保留它们对体积与行为都无影响。
 *
 * 退出码：0 = 正式产物干净；1 = 发现调试残留。
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await readFile(join(root, "lib", "client.js"), "utf8");

const FORBIDDEN = [
  ["诊断文本模板", "当前会话在状态"],
  ["探针实现", "sendProbe"],
  ["测试模式实现", "setTestMode"],
  ["探针载荷 key", "test-probe"]
];

const found = FORBIDDEN.filter(([, marker]) => bundle.includes(marker));
if (found.length > 0) {
  console.error("FAIL: production bundle still contains debug capability:");
  for (const [label, marker] of found) console.error(`  - ${label}: ${marker}`);
  console.error("\nRun `npm run build:client` (without --debug) before packing.");
  process.exit(1);
}
console.log(`OK: production bundle has no debug capability (${bundle.length} bytes)`);
