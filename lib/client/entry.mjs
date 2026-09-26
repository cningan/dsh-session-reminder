/**
 * Loader entry for the DSH Web Client bundle.
 *
 * `scripts/build-client.mjs` bundles this file (plus `./source.mjs`) into
 * `lib/client.js`, which is what the DSH module loader loads. Keep this file
 * free of side effects other than registering the plugin.
 */
import { createPlugin } from "./source.mjs";

window.__ModuleLoader__.load({
  id: "@cningan/dsh-session-status",
  factory: (loadModule) => createPlugin(loadModule)
});
