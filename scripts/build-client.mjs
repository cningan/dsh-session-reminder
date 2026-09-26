#!/usr/bin/env node
/**
 * 构建 Client bundle：`lib/client/` 源码 → loader-ready 的 `lib/client.js`。
 *
 *   node scripts/build-client.mjs     # 唯一的构建（`prepack` / `pretest` 都走它）
 *
 * 只有一种产物：主插件不含任何测试代码（诊断面板、探针、测试模式都已移出，见
 * [ADR-0003](../docs/adr/0003-test-capability-lives-outside-the-plugin.md)），所以不再有
 * `--debug` 分支与 `__DEBUG__` 构建期常量——`scripts/check-production-bundle.mjs` 直接
 * 断言这唯一产物的表面。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "lib", "client", "entry.mjs")],
  outfile: join(root, "lib", "client.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  charset: "utf8",
  legalComments: "none",
  minify: true,
  banner: { js: "/* Built by scripts/build-client.mjs from lib/client/ — do not edit lib/client.js directly. */" }
});

console.log("built lib/client.js");
