# Repository Agent Instructions

Before taking any action in this repository, read [HANDOFF.md](HANDOFF.md), then [README.md](README.md) and [SPEC.md](SPEC.md). HANDOFF.md is the current task checkpoint and records user constraints, runtime state, failed validation attempts, and the exact next steps.

- Never call Client Inspect through `cordis_inspect_query`.
- A valid automatic-notification E2E test must use a fresh, ordinary DSH user session and finish while the DSH page/window is hidden or unfocused. The active build conversation, a subagent, unit tests, and the foreground Settings self-check do not satisfy this test.
- Do not modify DSH core/preload or Profile mount configuration; the user declined core changes. Preserve any pre-existing Profile `cordis.patch.yml` edits.
- Do not claim E2E success or push to GitHub until the user-visible automatic notification is confirmed for a real session stop. Unit-test success is not sufficient.
- Keep source and commits in this plugin repository. Do not stage Profile runtime data or its Git changes.
