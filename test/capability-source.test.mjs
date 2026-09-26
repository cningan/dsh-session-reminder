/**
 * 能力/权限派生的**单一来源防线**（.scratch/session-status/issues/13-foreground-single-source.md）：宿主能力（桥的形状宣称、浏览器权限、
 * 用户激活）只允许由投递层的 `readCapabilities` 读取；其余 module 只能消费它派生出来的
 * **值**（`capability()` / `result.capability` / `delivery.permission()`）。
 *
 * 与 `test/normalize.test.mjs` 里那条「页面可见性/焦点只由归一化 module 读取」同构：
 * 两条防线各守住一个承重前置条件——「页面是否在前台」与「现在有哪些渠道可用」。
 * 任一处再写一次等价的宿主读取，这条断言就会失败（走查意见里的「3-5 个散点」）。
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const LIB_ROOT = fileURLToPath(new URL("../lib", import.meta.url));

/**
 * 宿主能力读取的特征：用户激活（`navigator.userActivation`）、`Notification` 这个全局
 * （判存在或取 `.permission`），以及桥的形状（`dshShell` / `chrome.webview`）。命中即意味着
 * 这个 module 在自己回答「现在有哪些渠道可用」，而那本该只在投递层发生一次。
 *
 * 只匹配真正的读取形态，不匹配散文：`navigator.language`（被否决的语言猜测）、
 * `sendTestNotification()`、`NotificationSettingsRow` 这类标识符都不算读取。
 */
const DERIVATION_READS = /navigator\.userActivation|typeof\s+Notification|\bNotification\s*[.(]|dshShell|chrome/;

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

const nameOf = (file) => relative(LIB_ROOT, file).split(sep).join("/");

test("能力/权限的派生只有一处：宿主对象只由投递层读取", async () => {
  const files = await moduleFiles(LIB_ROOT);
  const names = files.map(nameOf);

  // 阳性对照：扫描面确实覆盖了投递层与它的消费方，避免断言退化成永真。
  for (const expected of [
    "diagnostics-contract.mjs",
    "client/delivery.mjs",
    "client/assembly.mjs",
    "client/settings.mjs",
    "client/test-service.mjs",
    "client/normalize.mjs"
  ]) {
    assert.ok(names.includes(expected), `扫描面应包含 ${expected}`);
  }

  const readers = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    if (DERIVATION_READS.test(text)) readers.push(nameOf(file));
  }

  assert.deepEqual(readers, ["client/delivery.mjs"],
    "宿主能力（navigator / Notification / 桥）只允许在 client/delivery 里读取");
});

test("装配层消费的是派生值：装载快照、投递记录与设置区展示都走同一个派生", async () => {
  const assembly = await readFile(join(LIB_ROOT, "client", "assembly.mjs"), "utf8");

  // 三处消费点都必须存在（任一处退回自己读宿主对象，上面那条防线或本条会失败）。
  assert.match(assembly, /readCapabilities\(/, "装载快照应取能力派生的值");
  assert.match(assembly, /delivery\.capability\(\)/, "前台静默那一次也应用同一个派生值");
  assert.match(assembly, /result\.capability/, "记录/上报应用本次决策的那个能力值");
  assert.match(assembly, /delivery\.permission\(\)/, "设置区展示的那一问应走同一个派生");
  assert.doesNotMatch(assembly, DERIVATION_READS, "装配层不得自己读宿主能力");
});
