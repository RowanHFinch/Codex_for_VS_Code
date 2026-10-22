# Changelog

## Unreleased

- Serialize app-server initialization within one extension host to avoid native
  SQLite creation/migration races when multiple clients first open the same home.
  Connected clients continue to run ordinary requests independently.
- Treat a closed runtime output pipe as a disconnect immediately, preserving a
  complete final response and refusing further sends instead of waiting for an RPC timeout.
- Validate native checks against Codex 0.163.0. Codex 0.152.0–0.159.x can stall
  for 30 seconds before answering `initialize` while creating its SQLite state
  (fixed upstream in 0.160.0); 0.160.0 or newer is recommended.
- Capture bounded process/frame metadata in isolated native integration CI, and
  provide a manual Windows startup reproduction workflow without request retries.

## 0.9.0

First public release, consolidating local development versions.

- Independent Codex client with CLI sign-in reuse, English/Simplified Chinese UI,
  sidebar/editor chat surfaces and a separate session-management panel.
- Native pre-apply file review, eligible edit undo/rewind, editor context,
  diagnostics, session history, child tasks and conversation export.
- Skills, MCP configuration/forms, native ecosystem controls, local memory browsing,
  image attachment, terminal integration and response annotations.
- Dictation waits for final audio; New chat cancels pending/active recording and
  preserves an unsent draft in its previous tab.
- Existing native MCP configuration and OAuth credentials are reused.
- Faster runtime readiness, deferred chat creation, paginated history and reduced
  renderer work during streaming and draft editing.
- Hardened restoration paths, dirty-buffer and conflict checks, rollback handling,
  unknown-request recovery and child-task reconciliation.

See [release acceptance](docs/release-readiness.md) for actual verification and
remaining limitations. Internal milestone notes are not part of the public changelog.
