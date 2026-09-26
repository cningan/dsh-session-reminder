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
  factory: (loadModule) => createPlugin(loadModule)
});
