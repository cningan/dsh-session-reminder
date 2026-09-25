# @cningan/dsh-session-status Specification

This is the canonical current specification and code map for this package. It is based on the checked-in manifest, Client bundle, Host entry, and documentation. Source-level observations are not a substitute for runtime compatibility or end-to-end notification validation; unknown integration behavior is marked below.

## Purpose and scope

The DSH Web Client plugin sends attention reminders for every session whose running state it has observed, whether selected or in the background. It distinguishes a pending approval, plan review, or question from a completed, interrupted/failed, or otherwise unclassified stop. A stop without sufficient cause data is reported generically, never inferred as successful completion. Initial idle/waiting baselines and list removal alone do not notify; a terminal edge that coincides with a missing list row is also suppressed as a possible removal/archive. A global connection loss is not a session outcome; connection state is used only to resync after reconnection. DSH remains authoritative for session state and recovery.

The repository contains a loader-ready Client bundle plus an inert Host entry. Profile composition/deployment and the workbench shell implementation are external to this repository.

## Package and integration contract

| Surface | Checked-in contract |
|---|---|
| Package | @cningan/dsh-session-status, version 0.3.1, private ES module package |
| Host entry | main and package root export resolve to lib/index.js |
| Client entry | ./client export resolves to lib/client.js; dsh.client.platform is web |
| Client dependencies | Manifest injects @deepseek-ai/dsh-client-runtime, @deepseek-ai/dsh-client-connection, and @deepseek-ai/dsh-client-ui-session; the bundle declares the runtime capabilities slots, sessions, connection, and uiSession |
| Package scripts | `test` runs Node's built-in test runner over `test/*.test.js`; no generated build script is declared. |

A DSH profile composes the package by package name; its profile configuration is not maintained here. This repository's presence does not itself install, enable, or validate the plugin in a profile.

## Observable behavior

### Session events

- **Waits:** The bundle combines session-list rows (`sessions.list / byId`) with the all-session Map snapshot from `uiSession.sessionStatus`. It treats only `running === true` as running and reads each status's `pendingInteraction`. Only waits that arise after the plugin has observed a running session are eligible; a wait already present in the initial snapshot is baselined, not reported. `interaction.kind` maps approval to approval, plan review to plan review, and other values to question. Object identity plus session id deduplicates repeated snapshots. A wait notice takes precedence over a terminal notice for the same run.
- **Run terminal state:** Per-session run state observes every status-map entry, not just `uiSession.adapter.current`. Only a previously observed `running === true` to `false` edge can trigger; row disappearance alone is ignored. `completionUnread` signals unread output, not a stop cause or success, and is not used as a trigger. Only `turn/end` with `reason.kind === 'completed'` is classified as normal completion. For the selected session, the current `sessions.binding(id).eventSource` is observed without calling `retain` or `open`; Host `SessionEventWindow` defines `events[]` and `target` containing `SessionEvent` records, but the Client binding's exact snapshot shape and lifetime are not independently verified. If that feed is missing or differs, the stop stays generic/unknown. An `aborted` reason explicitly attributed to `user` is silent. An explicitly removed selected session is silent when its `SessionSnapshot` detail is available; background removed detail is not read. A terminal edge with a missing list row is suppressed as a possible removal/archive; `blocked`, `error`, `max-tokens`, and cause-attributed aborts get specific messages; `interrupted`, `forked`, legacy, and other ambiguous outcomes remain generic. Selected-session detail errors can provide additional reasons. Background sessions are never opened solely to obtain detail or history. Each run is notified at most once; a new running edge resets its suppression.
- **Connection:** `connection.state` remains subscribed for recovery synchronization. Non-connected states (including connecting) do not emit notifications because a transport loss does not prove any session stopped. On reconnection the plugin re-syncs sessions; it does not own or implement recovery.

### Delivery and settings

- Wait and stop-outcome notices are sent only while the corresponding DSH page/window is hidden or unfocused, regardless of which session is selected. The settings self-check is the deliberate foreground exception and uses a fixed test payload without changing session state.
- The workbench path first tries window.dshShell.notify(payload); if unavailable it tries window.chrome.webview.postMessage(payload). The payload contains only type, kind, title, and message—not the session id or a serialized session object. The checked Desktop bundle exposes no plugin-callable flash-only API; its internal BrowserWindow.flashFrame calls belong to modal UI. A flash-only route would require a DSH core/preload change, which the user declined for this task. External bridge presentation (toast/taskbar) and native click handling remain unverified.
- If no native bridge succeeds (none is exposed or every exposed bridge throws), the browser path uses the Notification API when browser permission is granted; a silent bridge no-op remains undetectable. A native bridge call is treated as delivered when it returns without throwing; the plugin cannot detect a silent no-op. Browser notifications request audible presentation with `silent: false`; browser/WebView and operating-system settings remain authoritative. Clicking a browser notification attempts to open its session through `sessions.open(sessionId)`, focuses the window, and closes the notification.
- The Settings → General → Session reminders row reports delivery-capability or browser permission state, can request browser permission, and exposes Send test reminder when delivery is available. It is registered in settings.general.item with id session-notifications and order 30; it is a capability/settings row, not a session-status display.
- The native bridge payload has no sound field. Whether the external shell plays a sound or handles click-to-session routing is **unknown in this repository**; do not infer those behaviors from the browser Notification path.

## Ownership and invariants

- DSH owns durable session truth, pending interactions, running/error state, selection semantics, and connection recovery. This plugin reads official Client surfaces and does not mutate DSH session state.
- Plugin-owned state is ephemeral: per-session run/wait edge deduplication, selected-session detail/event observation, and the delivery-capability/permission snapshot. It does not retain or open background sessions solely for notification reasons. No durable setting, localStorage session copy, or whole-session serialization is implemented.
- The Client uses subscriptions and page focus/visibility listeners, not a polling loop. Subscriptions, listeners, selected-session detail/event bindings, and injected style are disposed through the Client lifecycle effects.
- Notification sound, permission, and OS presentation are controlled by the browser/WebView, operating system, and (for the native route) external workbench integration.

## Compatibility boundary and known ambiguities

The checked-in bundle reads the 0.1.7-alpha.1-era uiSession.sessionStatus and connection.state contracts and has no fallback to the older field names. Runtime support outside those source-level contracts is **UNVERIFIED**; there is no independent runtime compatibility matrix. See [docs/compatibility.md](docs/compatibility.md), which preserves the recorded migration/repair history and its version discrepancy.

The live Client `SessionSnapshot` contract has no `nodes` field, so terminal reasons must not be inferred from undocumented node properties. Host `SessionEventWindow` exposes `events[]` and `target`; the selected binding's Client `eventSource` is parsed using those fields provisionally, because its exact window shape/lifetime could not be re-queried. If the feed is unavailable or differs, the plugin uses explicit `SessionSnapshot` errors or a generic unknown-stop notice. `completionUnread` neither triggers attention nor proves success. Non-selected sessions are not explicitly opened or retained to inspect event history, so background Stop/Cancel attribution may be unknown and produce a generic reminder.

The current Client catalog has no official notification Service/Event. This package probes optional `dshShell.notify` and WebView `postMessage` bridges, neither a documented plugin Service. Read-only review of the installed Desktop bundle found a `dshDesktop` preload but no notification method or plugin-callable flash-only API; internal `BrowserWindow.flashFrame` calls are confined to modal UI. External runtime injection and notification presentation remain unverified. A separate flash-only route needs a DSH core/preload change, which the user declined for this task.

## Directory and key-file responsibilities

| Path | Responsibility |
|---|---|
| package.json | Package identity/version/exports; DSH Web Client platform and injected runtime dependencies. |
| lib/index.js | Empty Host shim: inject = [] and apply() {}; behavior is Client-owned. |
| lib/client.js | Loader registration through window.__ModuleLoader__.load, with React obtained through the loader; all-session run/wait edge state, selected-session SessionSnapshot and eventSource classification, delivery-capability detection, reconnect resync, shell/browser adapters, Settings slot row, embedded CSS and lifecycle cleanup. This is the checked-in Client bundle, not a generated-from-source build target in this repository. |
| README.md / README.zh.md | English and Chinese user-facing purpose, enablement, limitations, and links to this specification. |
| CONTEXT.md | Shared domain glossary for session-reminder terms; contains no implementation chronology or API inventory. |
| docs/compatibility.md | Source-level compatibility observations plus historical adaptation/repair and validation records; not a runtime support matrix. |
| .gitignore | Excludes local dependencies, environment files, logs, cache, coverage, and dist output. |
| .gitattributes | Disables Git text normalization for package.json and lib/**. |

`test/client.test.js` uses Node's built-in test runner (`npm test`) to exercise lifecycle edges, event-reason classification, channel detection, deduplication, foreground suppression, and connection-loss behavior. These contract-level tests do not validate a live DSH integration, native shell behavior, or actual OS notifications; there is no generated build target in this repository.

## Maintenance rule

Update this file when package entries, runtime contracts, user-visible behavior, ownership invariants, or key paths change. Keep historical compatibility/repair facts in [docs/compatibility.md](docs/compatibility.md), not in a separate architecture-map document. Mark unsupported or unverified assumptions explicitly.
