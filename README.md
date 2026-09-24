# @local/dsh-session-status

English | [中文](README.zh.md)

## What it does

This DSH Web client plugin sends operating-system notifications for the **current session**. It covers an approval, plan-review, or question wait; the end of a run; an interrupted or failed run; and a lost DSH connection. It does not draw reminder cards, toasts, or a status overlay inside the page. Background-session completion is intentionally ignored.

Notifications are normally emitted only when the DSH page is hidden or unfocused. Clicking one focuses DSH and selects its owning session. The settings self-check is the intentional foreground exception and sends a fixed test payload without changing session state.

The plugin uses the official session list, current-session status/scope, current-session detail, and connection state. DSH remains the owner of session truth and reconnection. The plugin keeps only ephemeral edge-deduplication and notification-capability state; it does not persist session state or serialize whole session objects.

## Delivery paths

- In the DSH workbench, the client tries the optional shell notification bridge. The workbench owns native Windows presentation and taskbar flashing.
- In a direct browser visit, it uses the browser Notification API when permission is available.
- Both paths request sound, but browser/WebView and Windows settings remain authoritative; this plugin cannot override mute, Focus Assist, or volume settings.

The shell implementation is an external integration boundary and is not included in this repository.

## Package entry points

- The package name is @local/dsh-session-status, version 0.3.1. The package manifest marks it private.
- lib/index.js is the empty Host half: it declares no Host injection and has an empty apply function.
- lib/client.js is the loader-ready Client bundle and registers the session notification capability/settings row.

A DSH profile composes the package using its package name. Example insert row:

~~~yaml
- id: session-status
  name: '@local/dsh-session-status'
~~~

This repository is the maintained source location. A deployed profile is an external runtime/composition target; this repository setup did not modify any profile configuration.

## Enable and check

Open Settings → General → System notifications. In the workbench, the row reports whether the native bridge is connected. In a direct browser, grant notification permission using the row's enable action. Use Send test notification to exercise the available delivery path.

When deploying a package change to a DSH Web profile, use that environment's plugin validation and restart workflow. No profile deployment or end-to-end notification test was performed while creating this repository.

## Build and test status

There is currently no independent build or test pipeline for this package: the manifest declares no scripts, and the package has no src, test, or build directory. The checked-in Client file is already the DSH loader bundle. Static JavaScript syntax checks with Node are feasible; they do not replace host/plugin integration or real notification testing.

## Known limitations

- Browser notification permission and sound are controlled by the browser/WebView and operating system.
- The native workbench path depends on the optional shell bridge; that bridge's source and build pipeline are outside this repository.
- If DSH has not materialized the current session's detail object, terminal classification falls back to the status edge and may report a placeholder interruption reason. This is known debt, not changed by repository setup.
- Durable session truth and connection recovery remain owned by DSH.
