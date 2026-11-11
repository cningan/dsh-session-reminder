/**
 * Loader entry for the DSH Web Client bundle.
 *
 * `scripts/build-client.mjs` bundles this file (plus `./assembly.mjs` and the
 * plugin-page debug panel under `./dev-panel/`) into `lib/client.js`, which is
 * what the DSH module loader loads. Keep this file free of side effects other
 * than registering the plugin; the assembly (`./assembly.mjs`) is where the
 * official sources are normalized and wired.
 */
import { createPlugin } from "./assembly.mjs";

window.__ModuleLoader__.load({
  id: "dsh-session-reminder",
  // 插件有自己的页面（插件详情页里的调试工具），所以需要 loader 提供的 react。
  factory: (loadModule) => createPlugin(loadModule)
});
