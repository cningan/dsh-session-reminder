# @local/dsh-session-status Specification

This is the canonical current specification and code map for this package. It is based on the checked-in manifest, Client bundle, Host entry, and documentation. Source-level observations are not a substitute for runtime compatibility or end-to-end notification validation; unknown integration behavior is marked below.

## Purpose and scope

The DSH Web Client plugin sends operating-system notifications about the **currently selected session**: a pending approval, plan review, or question; a completed or interrupted/failed run; and a connection loss after a connection has previously been established. It does not render an in-page status overlay, persist session state, or notify on background-session completion. DSH remains authoritative for session state and reconnection.

The repository contains a loader-ready Client bundle plus an inert Host entry. Profile composition/deployment and the workbench shell implementation are external to this repository.

## Package and integration contract

| Surface | Checked-in contract |
|---|---|
| Package | @local/dsh-session-status, version 0.3.1, private ES module package |
| Host entry | main and package root export resolve to lib/index.js |
| Client entry | ./client export resolves to lib/client.js; dsh.client.platform is web |
| Client dependencies | Manifest injects @deepseek-ai/dsh-client-runtime, @deepseek-ai/dsh-client-connection, and @deepseek-ai/dsh-client-ui-session; the bundle declares the runtime capabilities slots, sessions, connection, and uiSession |
| Package scripts | None are declared. No separate source, test, or build directory/pipeline is present in this repository. |

A DSH profile composes the package by package name; its profile configuration is not maintained here. This repository's presence does not itself install, enable, or validate the plugin in a profile.

## Observable behavior

### Session events

- **Waits:** The bundle combines session-list rows (sessions.list / byId) with the per-session Map snapshot from uiSession.sessionStatus. It treats only running === true as running and reads pendingInteraction from that status. It emits a wait notice only when that session is the selected session from uiSession.adapter.current. interaction.kind maps approval to approval, plan-review to plan review, and other values to the question label. The interaction object identity is assigned a WeakMap sequence and combined with the session id for deduplication, so repeated snapshots of the same object do not repeat the same wait notice. completionUnread is not consumed; background completion remains intentionally ignored.
- **Run terminal state:** The currently selected session is observed via sessions.binding(sessionId).session. Error/removal changes or a running-to-not-running edge can trigger one terminal notice per run. Scalar error fields and the last node's kind/interrupted flag distinguish failure/interruption from normal completion. A later running edge clears the per-run suppression.
- **Connection:** connection.state is subscribed. Only connected is treated as connected. A loss notice is suppressed until a connected state has been observed, then emitted once for a non-connected state (including connecting) until reconnection. On restoration the plugin re-syncs sessions; it does not own or implement reconnection.

### Delivery and settings

- Session, terminal, and connection notices are sent only while the page is hidden or unfocused. The settings self-check is the deliberate foreground exception and uses a fixed test payload without changing session state.
- The workbench path first tries window.dshShell.notify(payload); if unavailable it tries window.chrome.webview.postMessage(payload). The payload contains only type, kind, title, and message—not the session id or a serialized session object. The workbench/native presentation and taskbar behavior are external to this repository. Native notification click handling is therefore not verified here.
- If the native bridge does not handle a notice, the browser path uses the Notification API when available and permission is granted. It requests audible presentation with silent: false; browser/WebView and operating-system settings remain authoritative. For browser notifications, clicking attempts to open the owning session through sessions.open(sessionId), focuses the window, and closes the notification.
- The Settings → General row reports bridge availability or browser permission state, can request browser permission, and exposes Send test notification when delivery is available. It is registered in settings.general.item with id session-notifications and order 30; it is a capability/settings row, not a session-status display.
- The native bridge payload has no sound field. Whether the external shell plays a sound or handles click-to-session routing is **unknown in this repository**; do not infer those behaviors from the browser Notification path.

## Ownership and invariants

- DSH owns durable session truth, pending interactions, running/error state, selection semantics, and connection recovery. This plugin reads official Client surfaces and does not mutate DSH session state.
- Plugin-owned state is ephemeral: edge/delivery deduplication, current-session observation, and the notification capability/permission snapshot. No durable setting, localStorage session copy, or whole-session serialization is implemented.
- The Client uses subscriptions and page focus/visibility listeners, not a polling loop. Subscriptions, listeners, current-session detail binding, and injected style are disposed through the Client lifecycle effects.
- Notification sound, permission, and OS presentation are controlled by the browser/WebView, operating system, and (for the native route) external workbench integration.

## Compatibility boundary and known ambiguities

The checked-in bundle reads the 0.1.7-alpha.1-era uiSession.sessionStatus and connection.state contracts and has no fallback to the older field names. Runtime support outside those source-level contracts is **UNVERIFIED**; there is no independent runtime compatibility matrix. See [docs/compatibility.md](docs/compatibility.md), which preserves the recorded migration/repair history and its version discrepancy.

There is also a source/documentation discrepancy around terminal classification when the current detail object is unavailable: the current status-edge fallback passes { running: false } to the classifier, which contains no error signal and therefore classifies as a normal completion. An earlier repository note said this case could produce a placeholder interruption reason. That earlier description does not match the inspected source path; real runtime behavior has not been verified, so the edge case remains an explicit unknown rather than a claimed contract.

The code comment at the top of lib/client.js says the current client catalog has no official system-notification or sound Service/Event and frames the browser Notification API as a reversible bridge. Re-check the upstream supported APIs before replacing or extending this integration. No Electron import or workbench source is included; the external workbench owns native Windows presentation and taskbar flashing according to the README.

## Directory and key-file responsibilities

| Path | Responsibility |
|---|---|
| package.json | Package identity/version/exports; DSH Web Client platform and injected runtime dependencies. |
| lib/index.js | Empty Host shim: inject = [] and apply() {}; behavior is Client-owned. |
| lib/client.js | Loader registration through window.__ModuleLoader__.load, with React obtained through the loader; notification model (current-session identity/title, pending/delivery/terminal deduplication, capability state, connection-loss sequence, disposal), official DSH subscriptions, wait/terminal/connection classification, shell/browser adapters, Settings slot row, embedded CSS and lifecycle cleanup. This is the checked-in Client bundle, not a generated-from-source build target in this repository. |
| README.md / README.zh.md | English and Chinese user-facing purpose, enablement, limitations, and links to this specification. |
| docs/compatibility.md | Source-level compatibility observations plus historical adaptation/repair and validation records; not a runtime support matrix. |
| .gitignore | Excludes local dependencies, environment files, logs, cache, coverage, and dist output. |
| .gitattributes | Disables Git text normalization for package.json and lib/**. |

There is no src/, test/, or build/ tree in the inspected package. The manifest declares no scripts. Node syntax checks are feasible but do not validate DSH integration, native shell behavior, or actual OS notifications.

## Maintenance rule

Update this file when package entries, runtime contracts, user-visible behavior, ownership invariants, or key paths change. Keep historical compatibility/repair facts in [docs/compatibility.md](docs/compatibility.md), not in a separate architecture-map document. Mark unsupported or unverified assumptions explicitly.
