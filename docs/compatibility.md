# DSH Client compatibility note

This note summarizes only the two contract changes recorded for DSH 0.1.7-alpha.1 in the 2026-09-22 adaptation note (§II), then checks the current side against this package's source. It is a source-level note, not a runtime support matrix.

| Surface | Historical change recorded in the adaptation note | Current bundle verified in this repo |
|---|---|---|
| Waiting interactions | From uiSession.pendingInteractions keyed by requestKey to uiSession.sessionStatus, a per-session Map containing running, pendingInteraction, and completionUnread. The note says pendingInteraction still carries kind. | readSessionStatus reads uiSession.sessionStatus.getSnapshot() and accepts a Map; syncSessions iterates it and reads running and pendingInteraction. The notification label reads interaction.kind. completionUnread is intentionally not consumed. See [status snapshot](../lib/client.js#L505-L517), [wait handling](../lib/client.js#L557-L577), and [kind mapping](../lib/client.js#L209-L212). |
| Connection state | From connection.hostDescription to connection.state with connected, connecting, and disconnected values. | observeConnection subscribes to ctx.connection.state. The package treats only connected as up. Loss notification is gated until a connected state has been seen; thereafter a non-connected state, including connecting, enters the loss path once until reconnection. See [connection handling](../lib/client.js#L598-L640). |

## Pending-interaction deduplication

The adaptation note records that the old request key disappeared and that one pendingInteraction object remains the same object instance across snapshots for one wait. The current bundle assigns object identities with a WeakMap and increasing sequence, then combines that identity with the session id for its deduplication key; it reads kind for the notification label. See [identity assignment](../lib/client.js#L285-L291), [deduplication key](../lib/client.js#L496-L503), and [wait notification](../lib/client.js#L563-L577). Static source confirms the implementation, not the upstream lifetime guarantee itself.

## Compatibility boundary

The current bundle consumes the new-side fields above and implements no fallback to the historical field names. The adaptation note is the source for the historical side; the current bundle verifies only the new-side reads. This note does not claim runtime compatibility with earlier DSH versions.

The adaptation note says connecting is not a disconnected state. Separately, the current package suppresses loss notices before the first connected state; after a connection has existed, connecting enters the same deduplicated loss path as other non-connected states. These are different layers: the API state label alone does not define the package's notification policy.
## Historical repair: DSH 0.1.5 wait notification

The 2026-09-14 maintenance record says wait notifications failed after the plugin read `pendingInteraction` from session-list rows, where the field no longer existed in the DSH 0.1.5 contract. The recorded replacement was `ctx.uiSession.pendingInteractions`, an observable map of pending objects carrying `key`, `kind`, and `sessionId`. This describes that historical repair, not the current hook.

The current child source uses the later `uiSession.sessionStatus` map and reads each status's `pendingInteraction`; it subscribes to `uiSession.sessionStatus` and contains no runtime read of `uiSession.pendingInteractions`. See [current status reader](../lib/client.js#L505-L517), [current wait handling](../lib/client.js#L557-L577), and [subscription](../lib/client.js#L681-L685). The current manifest is version `0.3.1` ([package.json](../package.json#L4)).

**Version record:** the historical report states `0.3.1 → 0.4.0`; the current manifest states `0.3.1`. These values differ. This note preserves both as recorded and does not infer a release or version chronology.

**Validation record:** the historical report records syntax and `plugin_check` passes. It also explicitly says the wait notification was not tested on a real device; the user judged the logic sufficient and treated it as passed. That was a user acceptance judgment, not an observed notification test. These are historical results, not validation of the current child checkout.

## Repository source snapshot validation (historical; date not recorded)

The previous code map recorded that Node JavaScript syntax checks were run against `lib/index.js` and `lib/client.js` during repository initialization. It also recorded that no `plugin_check`, Profile restart, or real notification end-to-end test was performed. This is a historical setup report, not validation of the current checkout.

## Terminal-detail fallback note

An earlier code-map note said that a missing current-session detail object could make the terminal status edge report a placeholder interruption reason. The inspected current source instead supplies `{ running: false }` at the status-edge fallback ([source](../lib/client.js#L584)); without other error fields, the classifier treats that as normal completion. The notes and source disagree, and the real runtime case remains unverified. See [SPEC.md](../SPEC.md) for the current source-level contract and ambiguity.
