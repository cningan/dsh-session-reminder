/**
 * 装配层的三条契约直测：
 *
 *   1. **Client 依赖清单单一来源**：`inject`（本地服务名，运行时注入用）与
 *      `package.json` 的 `dsh.client.inject`（官方包名，只用于排序激活）都由
 *      `client/assembly` 的 `CLIENT_DEPENDENCIES` 派生；这里断言两处名单一致
 *      ——任一处单方面增删都会让本测试失败，名单不再各自漂移。
 *      **本插件没有任何设置 UI，因此清单里没有 `slots`**：只有通知文案需要的 `locale`
 *      与四个会话/传输源；`slots` 只在设置行注册时才是依赖，这条断言防止它回来。
 *   2. **loader 契约**：同一份源码在内存里打成 bundle（`write: false`，不动仓库产物），
 *      装进最小假浏览器（`window.__ModuleLoader__.load`）跑一遍 `factory(loadModule)`，
 *      断言拿到的是**真正的插件表面**（`apply` 函数 + `inject` 清单），而不是任何
 *      CommonJS 拟态对象；插件没有 UI，因此不会向 loader 取任何模块。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

import { build } from "esbuild";

import { CLIENT_DEPENDENCIES, inject } from "../lib/client/assembly.mjs";

const ENTRY = fileURLToPath(new URL("../lib/client/entry.mjs", import.meta.url));
const MANIFEST = fileURLToPath(new URL("../package.json", import.meta.url));
const PLUGIN_ID = "@cningan/dsh-session-status";

const manifest = JSON.parse(await readFile(MANIFEST, "utf8"));

/** 去重且保留声明顺序。 */
function unique(values) {
  return [...new Set(values)];
}

test("inject 与 package.json 的 dsh.client.inject 由同一张依赖表派生、两处名单一致", () => {
  assert.ok(Array.isArray(manifest.dsh?.client?.inject), "package.json 应声明 dsh.client.inject");
  assert.ok(CLIENT_DEPENDENCIES.length > 0, "依赖表不应为空");

  // 表本身：每条都有服务名与提供它的官方包名。
  for (const entry of CLIENT_DEPENDENCIES) {
    assert.equal(typeof entry.service, "string", "依赖表的每一项都要有服务名");
    assert.match(entry.provider, /^@[^/]+\/.+/, `服务 ${entry.service} 的提供方应是官方包名`);
  }

  // 本地服务名清单：与表逐项同序、无重复（重复声明意味着两处名单可以漂移）。
  assert.deepEqual(inject, CLIENT_DEPENDENCIES.map(({ service }) => service));
  assert.equal(unique(inject).length, inject.length, "inject 不应有重复的服务名");

  // 没有设置 UI，就没有 slot 依赖：`slots` 与服务名、包名都不得出现在两处名单里。
  assert.equal(inject.includes("slots"), false, "主插件不含设置 UI，不应再注入 slots");
  assert.equal(
    manifest.dsh.client.inject.some((name) => name.includes("ui-slots")),
    false,
    "package.json 不应再声明 slots 的提供方包"
  );

  // 包名清单：去重后与 package.json 逐项同序（一个包可以提供多个服务，故只在去重后比对）。
  const providers = CLIENT_DEPENDENCIES.map(({ provider }) => provider);
  assert.deepEqual(unique(providers), manifest.dsh.client.inject);
});

test("依赖表把每个本地服务钉到已核实的官方提供方包", () => {
  // 这一张表是排序激活的唯一定义处；包名错了不会立刻炸，只会让激活顺序失去依据。
  // `sessions` 曾经写的是一个**不存在**的包（`@deepseek-ai/dsh-client-runtime`）：
  // DSH 0.2.2-rc.1 的 app.asar 里没有任何包叫这个名字，真正提供 `sessions` 的是
  // `@deepseek-ai/dsh-api-session-controller`（`rootCtx.reflect.provide("sessions", …)`）。
  // 逐项钉死，避免下一个版本再漂成猜测。见 .scratch/session-status/issues/14。
  assert.deepEqual(Object.fromEntries(CLIENT_DEPENDENCIES.map(({ service, provider }) => [service, provider])), {
    locale: "@deepseek-ai/dsh-client-locale",
    sessions: "@deepseek-ai/dsh-api-session-controller",
    connection: "@deepseek-ai/dsh-client-connection",
    uiSession: "@deepseek-ai/dsh-client-ui-session"
  });
});

/** 最小假浏览器：官方源替身，只为把 factory 跑起来（插件没有 UI，不应取任何模块）。 */
function launch(source) {
  let loaded;
  let plugin;
  const requested = [];

  const window = {
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    __ModuleLoader__: {
      load(input) {
        loaded = input;
        plugin = input.factory((name) => {
          requested.push(name);
          return {};
        });
      }
    }
  };

  const document = {
    visibilityState: "visible",
    documentElement: { lang: "en" },
    head: null,
    hasFocus: () => false,
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => null
  };

  vm.runInNewContext(source, {
    window,
    document,
    navigator: { language: "en", userActivation: { isActive: false, hasBeenActive: false } },
    Notification: class {
      static permission = "granted";
      static async requestPermission() { return "granted"; }
      close() {}
    },
    Map,
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    fetch: () => Promise.resolve({ ok: true }),
    console: { log() {}, info() {}, warn() {}, error() {} }
  }, { filename: "client.js" });

  return { loaded, plugin, requested };
}

async function bundleOf() {
  const result = await build({
    entryPoints: [ENTRY],
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["chrome120"],
    charset: "utf8",
    legalComments: "none",
    minify: true,
    write: false
  });
  return result.outputFiles[0].text;
}

test("loader 契约：__ModuleLoader__.load 拿到 id 与能跑出插件表面的 factory", async () => {
  const { loaded, plugin, requested } = launch(await bundleOf());

  assert.ok(loaded !== undefined, "bundle 应注册到 window.__ModuleLoader__.load");
  assert.equal(loaded.id, PLUGIN_ID);
  assert.equal(typeof loaded.factory, "function");
  // 插件没有 UI：factory 收到了 loadModule，但一次都不该用它（不再取 react）。
  assert.deepEqual(requested, [], "不含 UI 的插件不应向 loader 要任何模块");

  // 真正的 ESM 模块表面：只有 apply 与 inject 两个键，没有 CommonJS 拟态残留。
  assert.deepEqual(Object.keys(plugin), ["apply", "inject"]);
  assert.equal(typeof plugin.apply, "function");
  assert.ok(Array.isArray(plugin.inject));
  assert.deepEqual([...plugin.inject], inject);
  assert.equal(typeof plugin.require, "undefined");
  assert.equal(typeof plugin.module, "undefined");
  assert.equal(typeof plugin.exports, "undefined");
});
