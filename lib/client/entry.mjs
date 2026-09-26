/**
 * Loader entry for the DSH Web Client bundle.
 *
 * `scripts/build-client.mjs` bundles this file (plus `./assembly.mjs`) into
 * `lib/client.js`, which is what the DSH module loader loads. Keep this file
 * free of side effects other than registering the plugin; the assembly
 * (`./assembly.mjs`) is where the official sources are normalized and wired.
 */
import { createPlugin } from "./assembly.mjs";

window.__ModuleLoader__.load({
  id: "@cningan/dsh-session-status",
  // 插件不含任何 UI，因此不需要 loader 提供的模块（无 react）。
  factory: () => createPlugin()
});
