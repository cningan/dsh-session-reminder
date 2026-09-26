/**
 * Loader 入口：`scripts/build-client.mjs` 把本文件（连同 `./plugin.mjs` / `./panel.mjs` /
 * `./strings.mjs`）打成 `lib/client.js`，DSH Client 的模块加载器加载的就是它。
 *
 * 除了注册插件没有别的副作用；id 与 `package.json` 的包名一致（服务与 slot 的身份都用它）。
 */
import { PLUGIN_ID, createPlugin } from "./plugin.mjs";

window.__ModuleLoader__.load({
  id: PLUGIN_ID,
  factory: (loadModule) => createPlugin(loadModule)
});
