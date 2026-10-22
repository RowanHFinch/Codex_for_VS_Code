# Architecture and development scope

This independent extension uses the official Codex client experience as its
functional baseline, with additional editor and session workflows. The full
110-row scope and acceptance criteria are retained in `feature-matrix.json`.
Historical statuses are conservative planning records, not a current release certificate.

## Code map

| Path | Responsibility |
| --- | --- |
| `src/extension.ts` | VS Code activation, views, commands and validated host bridge |
| `src/runtime/` | Executable discovery, version checks, JSONL requests and events |
| `src/sessions/` | Conversations, tabs, queues, history, child tasks and ownership |
| `src/review/` | Native diff previews, edit records, checkpoints and restoration |
| `src/integrations.ts` | Native ecosystem configuration and workspace MCP grants |
| `src/protocol/` | Generated public Codex protocol declarations |
| `webview/`, `locales/` | One React bundle, theme-aware UI and language catalogs |
| `tests/`, `scripts/` | Regression fixtures, real editor/runtime checks and packaging |

The webview talks only to the validated extension-host bridge. The host starts a
local app-server over stdio using a distinct client identity. The runtime owns
authentication, history, model execution and tool policy. VS Code storage holds
presentation state and private recovery records. No hosted backend is required.

## Invariants

- Keep credentials, full native configuration and OAuth URLs out of renderer state.
- Bind decisions and asynchronous results to their workspace, connection, chat,
  turn and request. Stale responses must not mutate the newly selected chat.
- Native writer exclusion coordinates external clients; a local lease cannot
  guarantee exclusion against official clients.
- Never replay unknown requests. Reconcile state before allowing new writes.
- Pre-apply approval, post-apply undo and conversation-history rollback are
  different operations. Recovery must preserve dirty buffers and later manual edits.
- Preserve platform restrictions, path validation, no-overwrite creation, permission
  checks and original licenses. Generated protocol types are not vendor UI code.

## Current work

The current source includes deferred conversation creation, paginated history,
coalesced renderer updates and memoized Markdown. Prior same-machine measurements
reported 53.9 ms median app-server connection and 210/52 ms installed-editor first
open/warm navigation; these are local samples, not latency guarantees.

Release acceptance is tracked in `release-readiness.md`. Future work should close
specific remaining acceptance cases without expanding scope or rewriting working
layers. The roadmap includes broader platform/accessibility coverage, richer
plan/plugin workflows and remaining feature-ledger scenarios. Exact vendor-only
capabilities remain explicit blockers; partial implementation is not parity.
