# Architecture Map

## Package contract

| Surface | Current contract |
|---|---|
| Package | @local/dsh-session-status, version 0.3.1, private |
| Host entry | package main and root export resolve to lib/index.js |
| Client entry | package export ./client resolves to lib/client.js; DSH client metadata injects the bundle into the web client |
| Package scripts | None declared; no independent build/test pipeline is present |

## Runtime components

| Component | Responsibility | Location |
|---|---|---|
| Host shim | Exports inject as an empty array and apply as an empty function; the feature is browser/client-owned | lib/index.js |
| DSH loader registration | Registers @local/dsh-session-status through window.__ModuleLoader__.load and consumes React from the loader | lib/client.js |
| Notification model | Maintains current-session identity/title, edge deduplication, pending-interaction identity, permission/capability snapshot, connection generation, and disposal state | createStatusModel in lib/client.js |
| Session synchronization | Combines the official sessions list and uiSession.sessionStatus snapshot; observes only the selected/current session and intentionally ignores background-session completion | lib/client.js |
| Detail classifier | Reads scalar error fields and terminal-node kind/flags to distinguish completion from interruption/removal | detailOf, classifyDetail, observeCurrentDetail in lib/client.js |
| Delivery adapter | Sends a small type/kind/title/message payload to the optional workbench bridge; uses browser Notification as the browser path | nativeShellNotify, systemNotify in lib/client.js |
| Settings capability row | Reports native/browser permission availability and exposes a fixed-payload self-check; does not render session status | NotificationSettingsRow and apply in lib/client.js |
| Styles | Injects/removes the settings-row style with the client plugin lifecycle | CSS and installStyle in lib/client.js |

## State ownership and effects

- DSH owns session truth, pending interactions, running/error state, and reconnection. The plugin subscribes to official DSH client surfaces and does not change DSH core behavior.
- The plugin owns only ephemeral notification de-duplication and a capability/permission snapshot. It introduces no durable settings, localStorage state, or copied session store.
- Notification payloads contain only the notification type/kind/title/message. The workbench owns native Windows presentation/taskbar flashing; browser permission and sound remain browser/OS-controlled.
- Wait/terminal/connection notices are suppressed while the DSH page is focused, except for the explicit settings self-check.
- Client subscriptions, listeners, current-session detail binding, and injected style are disposed with the Client plugin fiber. There is no timer/polling loop in this package.

## External integration boundaries

- The Client uses DSH-provided sessions, uiSession, connection and settings slot APIs. No Electron import or workbench source is included.
- The optional workbench integration consumes window.dshShell.notify(payload) or the supported WebView bridge; a direct browser visit uses the browser Notification API.
- A DSH profile must compose the package by its package name. Profile configuration is not part of this repository and was not modified during setup.

## Known debt

If the current session's detail object is unavailable, the terminal status edge still produces a notification but the classifier may use a placeholder interruption reason rather than a neutral completion. This behavior is documented in the existing plugin notes and was not changed.

## Verification and pipeline

There is no src, test, or build directory, no package scripts, and no independent test/build pipeline. The static checks run for this repository initialization are Node syntax checks on lib/index.js and lib/client.js only. No plugin_check, Profile restart, or real notification end-to-end test was performed.
