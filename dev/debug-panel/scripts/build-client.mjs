#!/usr/bin/env node
/**
 * 构建调试面板的 Client bundle：`src/` → loader-ready 的 `lib/client.js`。
 *
 *   node scripts/build-client.mjs     # `prepack` / `pretest` 都走它
 *
 * 做法与主仓库 `scripts/build-client.mjs` 同款（esbuild、iife、`platform: "browser"`、
 * 压缩）：面板同样是「注册进 `window.__ModuleLoader__.load` 的浏览器 bundle」。
 * 区别只在产物位置与用途——这里的 `lib/client.js` 是**开发件**，随 dev 包进 tarball
 * 装给开发者的 profile，不进主插件发布包。
 *
 * esbuild 从仓库根的 `node_modules` 解析即可（本目录下的 `npm install` 可选）：
 * 本包位于主仓库内，Node 的模块解析会向上找到根依赖。
 */
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

await build({
  entryPoints: [join(root, "src", "entry.mjs")],
  outfile: join(root, "lib", "client.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["chrome120"],
  charset: "utf8",
  legalComments: "none",
  minify: true,
  banner: { js: "/* Built by dev/debug-panel/scripts/build-client.mjs from src/ — do not edit lib/client.js directly. Dev-only panel; not part of the @cningan/dsh-session-status release package. */" }
});

console.log("built dev/debug-panel/lib/client.js");
