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
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

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
  // 插件自己的版本号编进产物：页面里跑的到底是哪一版，只能从客户端自己报出来。
  // 它只进诊断记录（`client:attach` 的 `pluginVersion`），不参与任何判定。
  define: { __PLUGIN_VERSION__: JSON.stringify(manifest.version) },
  banner: { js: "/* Built by scripts/build-client.mjs from lib/client/ — do not edit lib/client.js directly. */" }
});

console.log("built lib/client.js");
