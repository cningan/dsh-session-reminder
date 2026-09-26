# @cningan/dsh-session-status

English | [中文](README.zh.md)

Canonical behavior, invariants, and spec: [SPEC.md](SPEC.md).

## What it does

This DSH Web Client plugin sends attention reminders for **every observed running session**, including sessions not currently selected. It distinguishes a wait for approval, plan review, or a question from a completed, interrupted, failed, or otherwise unclassified stop. A stop with insufficient cause data is reported generically rather than mislabeled as successful completion. An observed turn explicitly attributed to user cancellation is silent. An explicitly removed selected session is silent when that detail is available; a missing list row suppresses its terminal edge to avoid removal/archive notices. Background removal detail is not read. It does not draw reminder cards or a status overlay inside the page; a global DSH connection loss is not treated as a session stop.

Reminders are emitted only when the corresponding DSH page/window is hidden or unfocused; selection of a session does not limit which running sessions are watched. Clicking a browser notification asks DSH to open its session and focuses the window; native-bridge click handling belongs to the external workbench and is not verified here. The settings self-check is the intentional foreground exception and sends a fixed test payload without changing session state.

The plugin uses the official session list and all-session status map, plus the selected session's `SessionSnapshot` and `eventSource` when available. An unread-completion marker alone neither triggers a notice nor proves success; only an observed running-to-stopped edge is actionable, and absent `turn/end` cause data stays generic. Other sessions are never opened just to obtain detail or event history. Connection state is used only to re-sync after reconnection. DSH remains the owner of session truth and recovery. The plugin keeps only ephemeral edge-deduplication and delivery-capability state; it does not persist session state or serialize whole session objects.

## Delivery paths

- In the DSH workbench, the client tries `window.dshShell.notify(payload)`, then `window.chrome.webview.postMessage(payload)`. The checked Desktop bundle exposes no plugin-callable flash-only API; its `flashFrame` calls are private to modal UI. The inspected preload exposes `dshDesktop`, but no notification method was found; availability of the optional `dshShell`/WebView notification bridges in a target runtime is unverified. A flash-only route would require a DSH core/preload change, which the user declined, so this plugin keeps its existing bridge path and falls back to browser notifications if no bridge is exposed or all exposed bridges throw. A silent no-op from an exposed bridge cannot be detected.
- If neither workbench bridge succeeds, it falls back to the browser Notification API when browser permission is granted; in a direct browser, that is the primary path.
- Browser notifications set `silent: false` to request platform sound and always use a unique `tag`; they deliberately **never set `requireInteraction`**. In the desktop WebView a notification with `requireInteraction: true` is silently dropped — the constructor succeeds, but the platform never shows it and fires no `onshow`/`onerror`/`onclose` (confirmed by an A/B probe on 2026-09-26). All reminders therefore expire on the platform's default timeout. The native bridge payload has no sound field, so its sound behavior belongs to the external workbench. Browser/WebView and Windows settings remain authoritative; this plugin cannot override mute, Focus Assist, or volume settings.

The shell implementation is an external integration boundary and is not included in this repository.

## Package entry points

- The package name is @cningan/dsh-session-status, version 0.3.1. The package manifest marks it private.
- lib/index.js is the Host half: it injects `webServer`, owns the diagnostics sink (`/plugins/dsh-session-status/diagnostics`), and appends JSONL records under the profile's `.dsh-session-status/` directory. It never decides when a reminder is due.
- lib/client.js is the loader-ready Client bundle and registers the session notification capability plus a plugin settings section.

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), so the official channel can treat it as a bundle: install it with `plugin_manager` `install_bundle` (or Add plugin in the client) and that patch mounts the package's own entry (`id: session-status`, `name: '@cningan/dsh-session-status'`). Install from a local `.tgz`, whose contents are unpacked into the profile; do not use a directory or `link:` input, which only creates a junction and cannot resolve `@deepseek-ai/*`.

This repository is the maintained source location. A deployed profile is an external runtime/composition target; this repository does not hand-edit profile files (no manual `package.json` or `dsh.profile.bundles` changes).

## Enable and check

Open the plugin settings page and find its Session reminders section (registered on `settings.section`). Reminder text and the section follow the DSH interface language through the official locale service. The section reports a recognized workbench bridge or browser-notification permission state; when the bridge is absent, the browser path can still be enabled if supported. Use Send test reminder to exercise the available delivery path.

The `desktop` profile has the plugin installed through the official channel from a local tarball. The automatic session-stop path still requires an end-to-end check in a separate DSH session; do not treat the settings self-check or unit tests as that validation.

## Diagnostics

The Client half reports what it observed — load snapshot, session/status source shape, run edges, the foreground test, the delivery result, and the platform's own notification lifecycle events — to the Host half, which appends them to `<profile>/.dsh-session-status/diagnostics.jsonl`; the Host also writes a `host-ready` marker on load, which separates "Host never ran" from "Client never reported". Run `npm run diagnose` (or `node scripts/check-diagnostics.mjs <file>`) to read that file and get a verdict with an exit code. The verdict words and their exit-code meanings have a **single source of truth: the `VERDICTS` table documented at the top of `scripts/check-diagnostics.mjs`** — this document deliberately does not restate them. The reader separates "the delivery call succeeded" (`delivered: true`, i.e. `new Notification()` did not throw) from "the platform confirmed the notice was shown" (an `onshow` or `onclose` for the same key): only the latter is the evidence [ADR-0001](docs/adr/0001-no-require-interaction-short-unique-tags.md) rests on. A successful call with no platform event for that key is reported as unconfirmed, never as success, and an `onerror` is reported as a platform rejection carrying its error text. This is how a run is audited after the fact instead of watching the window.

## Compatibility

This bundle consumes `uiSession.sessionStatus`, `connection.state`, the selected binding's `eventSource`, and official `SessionSnapshot` error fields; it does not depend on undocumented `nodes`. The Host `SessionEventWindow` schema has `events` and `target`, but the Client binding's exact window/lifetime contract remains unverified; missing or mismatched event data degrades to a generic notice. See [docs/compatibility.md](docs/compatibility.md).

## Build

`lib/client.js` is a **build artifact** (esbuild bundle, header marks it "do not edit") generated from `lib/client/`:

- `npm run build:client` — production bundle: no diagnostics panel, no probes, no test-mode API ([ADR-0002](docs/adr/0002-debug-capability-only-in-debug-build.md))
- `npm run build:client:debug` — debug bundle: keeps the diagnostics panel and `sendProbe`/`sendProbeBurst`/`setTestMode` for local triage
- `npm test` — its `pretest` builds the debug bundle first; the suite then runs against it
- `npm run check:production` — builds production and asserts the artifact carries no debug capability
- `npm run diagnose` — reads `<profile>/.dsh-session-status/diagnostics.jsonl` and prints a verdict with an exit code
- `prepack` builds production, so tarball installs never ship debug code

## Build and test status

Run `npm test` for the built-in Node test suite covering session edges, terminal reasons, channel detection, foreground rules, connection-loss suppression, the plugin settings-section registration, locale-dictionary language following, the delivery layer's channel fallback and platform-event feedback (minimal doubles only, no whole-browser simulation), and the diagnostics reader's verdicts (fixed-sample JSONL for platform-confirmed, platform-rejected, and unconfirmed deliveries). The checked-in Client file is already the DSH loader bundle; tests do not replace host/plugin integration or real notification testing.

## Known limitations

- Browser notification permission and sound are controlled by the browser/WebView and operating system.
- Workbench bridge availability and presentation are unverified in a live target; the inspected Desktop preload exposed no notification method.
- If no current-session `turn/end` reason or explicit error is available at the stop edge, the plugin uses a generic unknown-stop notice. Removed state is read only for the selected session; background Stop/Cancel/removal attribution may therefore be unknown and notify generically. A missing list row at the stop edge is suppressed as a possible archive/removal.
- Durable session truth and connection recovery remain owned by DSH.
