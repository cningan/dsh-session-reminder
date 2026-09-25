# DSH Client compatibility note

This note summarizes only the two contract changes recorded for DSH 0.1.7-alpha.1 in the 2026-09-22 adaptation note (§II), then checks the current side against this package's source. It is a source-level note, not a runtime support matrix.

| Surface | Historical change recorded in the adaptation note | Current bundle verified in this repo |
|---|---|---|
| Waiting interactions | From uiSession.pendingInteractions keyed by requestKey to uiSession.sessionStatus, a per-session Map containing running, pendingInteraction, and completionUnread. The note says pendingInteraction still carries kind. | readSessionStatus accepts the all-session Map; syncSessions iterates every entry, reads running and pendingInteraction, and uses interaction.kind for the label. Initial waits are baselined; subsequent waits are deduplicated by object identity and session id. See [status snapshot](../lib/client.js#L603-L613), [wait handling](../lib/client.js#L664-L679), and [kind mapping](../lib/client.js#L212-L216). |
| Connection state | From connection.hostDescription to connection.state with connected, connecting, and disconnected values. | observeConnection still subscribes to ctx.connection.state and treats only connected as up, but non-connected states are no longer notification causes. Reconnection only re-syncs session status. See [connection handling](../lib/client.js#L704-L737). |
| Terminal reason | Host `session/event` emits a post-commit `SessionEvent` with `seq`, `type`, and `data`; Host `SessionEventWindow` has `events[]` and `target`. The Client session binding's `eventSource` is known from the existing Client contract, but its exact window shape and lifetime were not re-queried. | The plugin observes only the selected binding, never explicitly calls `retain` or `open`, and parses the Host window shape provisionally. Only `turn/end` with `reason.kind === 'completed'` proves success; `completionUnread` alone neither triggers a notice nor classifies its cause. Explicit aborted-by-user outcomes are silent. A `removed` detail is consulted only for the selected session; background removal/Stop/Cancel causes can remain unknown and produce a generic notice. A terminal edge with no list row is suppressed as a possible archive/removal. Ambiguous interrupted/forked/legacy or unavailable feed outcomes stay generic. Background sessions are not opened for event history. See [turn-end classifier](../lib/client.js#L271-L293), [event-source binding](../lib/client.js#L482-L588), and [terminal handling](../lib/client.js#L456-L479). |

## Pending-interaction deduplication

The adaptation note records that the old request key disappeared and that one pendingInteraction object remains the same object instance across snapshots for one wait. The current bundle assigns object identities with a WeakMap and increasing sequence, then combines that identity with the session id for its deduplication key; it reads kind for the notification label. See [identity assignment](../lib/client.js#L591-L597), [deduplication key](../lib/client.js#L220-L222), and [wait notification](../lib/client.js#L670-L679). Static source confirms the implementation, not the upstream lifetime guarantee itself.

## Compatibility boundary

The current bundle consumes the new-side fields above and implements no fallback to the historical field names. The adaptation note is the source for the historical side; the current bundle verifies only the new-side reads. This note does not claim runtime compatibility with earlier DSH versions.

The adaptation note says connecting is not a disconnected state. The current package still treats only connected as available, but non-connected values only mark transport loss for later resynchronization; they never generate a session notification. These are different layers: the API state label alone does not define the package's notification policy.
## Historical repair: DSH 0.1.5 wait notification

The 2026-09-14 maintenance record says wait notifications failed after the plugin read `pendingInteraction` from session-list rows, where the field no longer existed in the DSH 0.1.5 contract. The recorded replacement was `ctx.uiSession.pendingInteractions`, an observable map of pending objects carrying `key`, `kind`, and `sessionId`. This describes that historical repair, not the current hook.

The current child source uses the later `uiSession.sessionStatus` map and reads each status's `pendingInteraction`; it subscribes to `uiSession.sessionStatus` and contains no runtime read of `uiSession.pendingInteractions`. See [current status reader](../lib/client.js#L603-L613), [current wait handling](../lib/client.js#L664-L691), and [subscription](../lib/client.js#L778-L783). The current manifest is version `0.3.1` ([package.json](../package.json#L4)).

**Version record:** the historical report states `0.3.1 → 0.4.0`; the current manifest states `0.3.1`. These values differ. This note preserves both as recorded and does not infer a release or version chronology.

**Validation record:** the historical report records syntax and `plugin_check` passes. It also explicitly says the wait notification was not tested on a real device; the user judged the logic sufficient and treated it as passed. That was a user acceptance judgment, not an observed notification test. These are historical results, not validation of the current child checkout.

## Repository source snapshot validation (historical; date not recorded)

The previous code map recorded that Node JavaScript syntax checks were run against `lib/index.js` and `lib/client.js` during repository initialization. It also recorded that no `plugin_check`, Profile restart, or real notification end-to-end test was performed. This is a historical setup report, not validation of the current checkout.

## Historical terminal-detail fallback note (superseded)

An earlier code-map note said that a missing current-session detail object could make the terminal status edge report a placeholder interruption reason. At that time the inspected source supplied `{ running: false }` at its status-edge fallback and treated missing error detail as normal completion. That behavior has since been replaced: the current source provisionally reads `turn/end` from the selected binding using Host's `SessionEventWindow` fields, and otherwise uses explicit error detail or a generic unknown-stop notice. `completionUnread` neither triggers attention nor classifies a stop as successful. The Client binding's exact window shape remains unverified. See [SPEC.md](../SPEC.md) for the current source-level contract.
