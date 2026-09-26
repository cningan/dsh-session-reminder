#!/usr/bin/env node
/**
 * 构建 Client bundle：`lib/client/` 源码 → loader-ready 的 `lib/client.js`。
 *
 *   node scripts/build-client.mjs            # 正式构建：不含诊断/探针 UI
 *   node scripts/build-client.mjs --debug    # 调试构建：含诊断区与探针按钮
 *
 * 两种构建都保留诊断**上报**（Host 侧落盘），只有 UI 层差异：
 * 调试 UI 由 `__DEBUG__` 常量在构建期裁剪，正式产物里不存在该页面。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.argv.includes("--debug");

await build({
  entryPoints: [join(root, "lib", "client", "entry.mjs")],
  outfile: join(root, "lib", "client.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  charset: "utf8",
  legalComments: "none",
  minify: !debug,
  define: { __DEBUG__: debug ? "true" : "false" },
  banner: { js: "/* Built by scripts/build-client.mjs from lib/client/ — do not edit lib/client.js directly. */" }
});

console.log(`built lib/client.js (${debug ? "debug" : "production"})`);
